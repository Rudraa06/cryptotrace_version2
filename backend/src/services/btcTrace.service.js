import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { approximateUsd } from '../lib/valuation.js';
import { runInTransaction, fromNeoInt, GraphDisabledError } from './neo4j.service.js';

export const MAX_HOPS_CEILING = 25;
export const DEFAULT_MAX_HOPS = 15;
export const MAX_CONTEXT_EDGES = 40;

function isValidBtcAddress(address) {
  return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(address);
}

export function assertHopBound(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HOPS_CEILING) {
    const error = new Error(`maxHops must be an integer between 1 and ${MAX_HOPS_CEILING}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

export function buildBtcShortestPathCypher(maxHops) {
  const bound = assertHopBound(maxHops);
  return `
MATCH (startAddr:BtcAddress { address: $address })-[:BELONGS_TO]->(start:BtcCluster)
MATCH path = shortestPath((start)-[:SENT_TO*1..${bound}]->(exchange:BtcCluster { isExchange: true }))
WHERE exchange <> start
RETURN [c IN nodes(path) | c.clusterId] AS clusters,
       exchange.clusterId AS exchangeAddress,
       exchange.exchange AS exchangeName,
       length(path) AS hops
ORDER BY hops ASC, exchangeName ASC
LIMIT 20
  `.trim();
}

export function findTemporalBreak(steps) {
  let previous = null;
  for (let index = 0; index < steps.length; index++) {
    const current = steps[index].timestamp;
    if (current === null || current === undefined) continue;
    if (previous !== null && current < previous) return index;
    previous = current;
  }
  return -1;
}

async function readStartContext(tx, address) {
  const result = await tx.run(`
    MATCH (a:BtcAddress { address: $address })
    RETURN a.address AS address
  `, { address });

  const exchangeCount = await tx.run(
    'MATCH (c:BtcCluster) WHERE c.isExchange = true RETURN count(c) AS total'
  );

  return {
    exchangeWalletsInGraph: fromNeoInt(exchangeCount.records[0]?.get?.('total')) ?? 0,
    start: result.records.length > 0
      ? { address, inGraph: true, addressDisplay: address }
      : { address, inGraph: false, addressDisplay: address }
  };
}

export async function findBtcCashOutPaths(rawAddress, options = {}) {
  if (!config.graph.enabled) throw new GraphDisabledError();
  if (!isValidBtcAddress(rawAddress)) {
    throw new Error('Invalid BTC address');
  }

  const address = rawAddress;
  const maxHops = assertHopBound(options.maxHops ?? DEFAULT_MAX_HOPS);
  const startedAt = Date.now();
  const cypher = buildBtcShortestPathCypher(maxHops);

  return runInTransaction('READ', async (tx) => {
    const { start, exchangeWalletsInGraph } = await readStartContext(tx, address);
    const warnings = [];

    if (!start.inGraph) {
      return emptyResult({
        address, start, maxHops, exchangeWalletsInGraph, startedAt,
        reason: 'BTC_ADDRESS_NOT_IN_GRAPH',
        message: 'This BTC address has not been ingested yet.',
        hint: 'Run the UTXO ingestion first.'
      });
    }

    if (exchangeWalletsInGraph === 0) {
      return emptyResult({
        address, start, maxHops, exchangeWalletsInGraph, startedAt,
        reason: 'NO_BTC_EXCHANGE_SEEDED',
        message: 'No BTC clusters are flagged as exchanges in the graph.',
        hint: 'Seed the known BTC exchanges first.'
      });
    }

    const result = await tx.run(cypher, { address });
    
    if (result.records.length === 0) {
      return emptyResult({
        address, start, maxHops, exchangeWalletsInGraph, startedAt,
        reason: 'NO_ROUTE_FOUND',
        message: 'No route to a BTC exchange found within maxHops.',
        hint: 'Try increasing maxHops or ingest more history.'
      });
    }

    const paths = [];
    for (const record of result.records) {
      const clusters = record.get('clusters');
      const hops = fromNeoInt(record.get('hops'));
      const exchangeName = record.get('exchangeName');
      const exchangeAddress = record.get('exchangeAddress');

      const steps = [];
      // Resolve exact transactions for each cluster hop
      for (let i = 0; i < clusters.length - 1; i++) {
        const source = clusters[i];
        const target = clusters[i + 1];

        const stepResult = await tx.run(`
          MATCH (c1:BtcCluster {clusterId: $source})<-[:BELONGS_TO]-(a1:BtcAddress)-[:OWNS]->(:BtcOutput)-[:SPENT_BY]->(t:BtcTransaction)-[:HAS_OUTPUT]->(o:BtcOutput)<-[:OWNS]-(a2:BtcAddress)-[:BELONGS_TO]->(c2:BtcCluster {clusterId: $target})
          WITH c1, c2, t, o
          ORDER BY t.blockTime ASC
          LIMIT 1
          RETURN c1.clusterId AS fromCluster, c2.clusterId AS toCluster, t.txid AS hash, o.valueSats AS valueSats, t.blockTime AS blockTime, t.blockHeight AS blockHeight, c1.tags AS fromTags, c2.tags AS toTags,
                 [(a:BtcAddress)-[:BELONGS_TO]->(c1) | a.address] AS fromMembers,
                 [(b:BtcAddress)-[:BELONGS_TO]->(c2) | b.address] AS toMembers
        `, { source, target });

        if (stepResult.records.length > 0) {
          const stepRec = stepResult.records[0];
          const valueSats = fromNeoInt(stepRec.get('valueSats')) ?? 0;
          const btcValue = valueSats / 1e8; // Convert satoshis to BTC
          
          const stepObj = {
            hop: i + 1,
            from: stepRec.get('fromCluster'),
            fromDisplay: stepRec.get('fromCluster'),
            fromMembers: stepRec.get('fromMembers') || [],
            to: stepRec.get('toCluster'),
            toDisplay: stepRec.get('toCluster'),
            toMembers: stepRec.get('toMembers') || [],
            hash: stepRec.get('hash'),
            amount: btcValue, // Store raw BTC amount
            asset: 'BTC',
            assetClass: 'native',
            timestamp: fromNeoInt(stepRec.get('blockTime')),
            blockNumber: fromNeoInt(stepRec.get('blockHeight')),
            toIsExchange: (i === clusters.length - 2),
            fromTags: stepRec.get('fromTags') || [],
            toTags: stepRec.get('toTags') || []
          };
          
          steps.push(stepObj);
        }
      }

      const amounts = steps.map(s => s.amount).filter(n => Number.isFinite(n) && n > 0);
      const temporalBreak = findTemporalBreak(steps);
      const amountIntoExchange = steps.length > 0 ? steps[steps.length - 1].amount : 0;
      
      paths.push({
        exchange: {
          address: exchangeAddress,
          addressDisplay: exchangeAddress,
          exchange: exchangeName,
          label: exchangeName
        },
        hops,
        amountIntoExchange,
        assetIntoExchange: 'BTC',
        amountIntoExchangeUsdApprox: steps.length > 0 ? Number(approximateUsd(steps[steps.length - 1]).toFixed(2)) : 0,
        bottleneckAmount: amounts.length > 0 ? Math.min(...amounts) : 0,
        firstSeenAt: steps.find(s => s.timestamp !== null)?.timestamp ?? null,
        lastSeenAt: [...steps].reverse().find(s => s.timestamp !== null)?.timestamp ?? null,
        temporallyOrdered: temporalBreak === -1,
        ...(temporalBreak === -1 ? {} : { temporalBreakAtHop: temporalBreak + 1 }),
        steps
      });
    }

    paths.sort((a, b) => {
      if (a.hops !== b.hops) return a.hops - b.hops;
      if (b.amountIntoExchangeUsdApprox !== a.amountIntoExchangeUsdApprox) {
        return b.amountIntoExchangeUsdApprox - a.amountIntoExchangeUsdApprox;
      }
      return String(a.exchange.exchange ?? '').localeCompare(String(b.exchange.exchange ?? ''));
    });

    const outOfOrder = paths.filter((path) => !path.temporallyOrdered);
    if (outOfOrder.length > 0) {
      warnings.push(
        `${outOfOrder.length} of ${paths.length} route(s) contain a transfer that is older than ` +
          'the transfer feeding it, which is not physically possible for a single flow of funds.'
      );
    }

    logger.info('BTC Cash-out paths resolved', {
      address,
      paths: paths.length,
      shortest: paths[0]?.hops,
      durationMs: Date.now() - startedAt,
    });

    return {
      found: true,
      query: { address, addressDisplay: address, maxHops },
      start,
      topExchange: paths[0].exchange,
      shortestHops: paths[0].hops,
      paths,
      contextEdges: [], // Can implement context fan-out similarly to EVM later
      crossChain: [],
      stats: {
        pathsFound: paths.length,
        exchangesReached: new Set(paths.map((p) => p.exchange.address)).size,
        exchangeWalletsInGraph,
        temporallyInconsistentPaths: outOfOrder.length,
        durationMs: Date.now() - startedAt,
      },
      warnings,
    };
  });
}

function emptyResult({ address, start, maxHops, exchangeWalletsInGraph, startedAt, reason, message, hint }) {
  logger.info('No BTC cash-out path found', { address, reason });
  return {
    found: false, reason, message, hint,
    query: { address, addressDisplay: address, maxHops },
    start, topExchange: null, shortestHops: null,
    paths: [], contextEdges: [], crossChain: [],
    stats: { pathsFound: 0, exchangesReached: 0, exchangeWalletsInGraph, durationMs: Date.now() - startedAt },
    warnings: [],
  };
}
