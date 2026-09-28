/**
 * services/trace.service.js
 * ---------------------------------------------------------------------------
 * PHASE 3 - the query that answers the problem statement.
 *
 * Phase 1 fetched transactions. Phase 2 stored them. This module asks the graph
 * the actual investigative question:
 *
 *     "Starting from this victim-reported wallet, what is the shortest route by
 *      which the money reached a centralised exchange, and which exchange was it?"
 *
 * expressed as Cypher:
 *
 *     MATCH path = shortestPath((start)-[:TRANSACTION*1..15]->(exchange))
 *     WHERE exchange.isExchange = true
 *
 * -----------------------------------------------------------------------------
 * FOUR DECISIONS WORTH KNOWING ABOUT
 *
 * 1. ONE SHORTEST PATH PER REACHABLE EXCHANGE, not one path overall.
 *    `shortestPath` returns a single path, but laundered funds are routinely
 *    split across several venues on purpose. Returning only the nearest exchange
 *    would hide the others, and a hidden cash-out point is a missed lead in a
 *    fraud report. So we find every reachable exchange and run shortestPath to
 *    each, then union the results into one subgraph.
 *
 * 2. WE DO NOT SUM AMOUNTS ALONG A PATH.
 *    Summing would count the same money once per hop and produce a confident,
 *    inflated number. What is meaningful is what actually landed at the exchange
 *    (the final transfer) and the bottleneck (the smallest transfer on the route,
 *    which upper-bounds how much of the victim's money could have travelled the
 *    whole way). Both are reported; neither is a total.
 *
 *    Relatedly: when two routes are the same length, the tiebreak compares them
 *    in approximate USD (`lib/valuation.js`), not raw amounts. Two routes can end
 *    in different assets, and ranking 32,500 USDT above 12 ETH on the numbers
 *    alone would be backwards. The REPORTED figure is still the real amount in
 *    its own asset - the estimate only decides the order.
 *
 * 3. PATHS ARE CHECKED FOR TEMPORAL CONSISTENCY.
 *    `shortestPath` is a topological search - it does not know that money cannot
 *    leave a wallet before it arrives. A path whose timestamps go backwards is
 *    not a laundering route, it is a coincidence of shared addresses. Rather than
 *    silently presenting those as evidence, each path carries
 *    `temporallyOrdered`, and out-of-order paths are flagged in `warnings`.
 *    This is the single most likely source of a false positive here, so it is
 *    surfaced rather than buried.
 *
 * 4. "NO RESULT" IS THREE DIFFERENT ANSWERS.
 *    Wallet absent from the graph, no exchange seeded, and genuinely no route are
 *    completely different situations with completely different fixes. Collapsing
 *    them into an empty array would make an unseeded database look like a clean
 *    wallet - the same "wrong quietly" failure the Phase 2 uniqueness decision
 *    avoided. Each returns its own `reason` and `hint`.
 */

import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { normalizeAddress, toChecksum } from '../lib/addresses.js';
import { approximateUsd } from '../lib/valuation.js';
import { runInTransaction, fromNeoInt, toNeoInt, GraphDisabledError } from './neo4j.service.js';

/**
 * Ceiling on `?maxHops`.
 *
 * The roadmap specifies 15, which is the default. The hard ceiling is a little
 * higher so the limit can be raised for a stubborn case, but not without bound:
 * a variable-length pattern is exponential in the worst case, and an unbounded
 * one against a well-connected graph does not fail, it simply never returns -
 * which during a demo is indistinguishable from a crash but harder to explain.
 */
export const MAX_HOPS_CEILING = 25;

/** Roadmap default. */
export const DEFAULT_MAX_HOPS = 15;

/** Hard cap on context edges, so the Phase 4 canvas cannot be flooded. */
export const MAX_CONTEXT_EDGES = 40;

/**
 * Build the path-finding Cypher.
 *
 * The hop bound is interpolated rather than parameterised because Cypher does not
 * accept a parameter inside a variable-length pattern - `[:TRANSACTION*1..$max]`
 * is a syntax error, not a slow query. That makes this the one place in the
 * codebase where a value reaches a query as text, so `maxHops` is forced through
 * an integer/range check first and the query is built from the checked number,
 * never from the caller's string.
 *
 * @param {number} maxHops
 * @returns {string}
 */
export function buildShortestPathCypher(maxHops) {
  const bound = assertHopBound(maxHops);

  return `
MATCH (start:Wallet { address: $address })
MATCH path = shortestPath((start)-[:TRANSACTION*1..${bound}]->(exchange:Wallet { isExchange: true }))
WHERE exchange.address <> $address
RETURN path              AS path,
       exchange.address        AS exchangeAddress,
       exchange.addressDisplay AS exchangeDisplay,
       exchange.exchange       AS exchangeName,
       exchange.exchangeLabel  AS exchangeLabel,
       length(path)            AS hops
ORDER BY hops ASC, exchangeName ASC
LIMIT 20
`.trim();
}

/**
 * Validate a hop bound before it is interpolated into Cypher.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function assertHopBound(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HOPS_CEILING) {
    const error = new Error(
      `maxHops must be an integer between 1 and ${MAX_HOPS_CEILING}, received ${JSON.stringify(value)}.`
    );
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

/**
 * Read the properties off a driver Node, tolerating the plain objects the
 * offline test driver produces.
 * @param {any} node
 */
function nodeProps(node) {
  return node?.properties ?? node ?? {};
}

/**
 * Turn one driver Path into our own step list.
 *
 * A driver Path exposes `segments`, each `{ start, relationship, end }`, already
 * in traversal order - which is why we do not have to re-derive direction from
 * the relationship endpoints.
 *
 * @param {any} path
 * @returns {Array<object>}
 */
function pathToSteps(path) {
  const segments = path?.segments ?? [];

  return segments.map((segment, index) => {
    const edge = nodeProps(segment.relationship);
    const from = nodeProps(segment.start);
    const to = nodeProps(segment.end);

    return {
      // 1-based: "hop 1" is the reported wallet's own outgoing transfer, which
      // is how an investigator counts it.
      hop: index + 1,
      from: from.address ?? null,
      fromDisplay: from.addressDisplay ?? (from.address ? toChecksum(from.address) : null),
      to: to.address ?? null,
      toDisplay: to.addressDisplay ?? (to.address ? toChecksum(to.address) : null),
      fromContractTag: from.contractTag ? JSON.parse(from.contractTag) : null,
      hash: edge.hash ?? null,
      uniqueId: edge.uniqueId ?? null,
      amount: Number(fromNeoInt(edge.amount) ?? 0),
      asset: edge.asset ?? null,
      assetClass: edge.assetClass ?? null,
      contract: edge.contract ?? null,
      timestamp: fromNeoInt(edge.timestamp) ?? null,
      blockNumber: fromNeoInt(edge.blockNumber) ?? null,
      category: edge.category ?? null,
      toIsExchange: Boolean(to.isExchange),
      toRiskScore: fromNeoInt(to.riskScore) ?? null,
      toContractTag: to.contractTag ? JSON.parse(to.contractTag) : null,
      toTags: to.tags ?? null,
      fromTags: from.tags ?? null,
      swapEvent: edge.swapEvent ? JSON.parse(edge.swapEvent) : null,
    };
  });
}

/**
 * Check that money never leaves a wallet before it arrives.
 *
 * Returns the first offending step index, or -1 when the path is consistent.
 * Steps with a missing timestamp are skipped rather than assumed bad - absent
 * data is not evidence of an impossible route.
 *
 * @param {Array<{ timestamp: number|null }>} steps
 * @returns {number}
 */
export function findTemporalBreak(steps) {
  let previous = null;

  for (let index = 0; index < steps.length; index += 1) {
    const current = steps[index].timestamp;
    if (current === null || current === undefined) continue;
    if (previous !== null && current < previous) return index;
    previous = current;
  }

  return -1;
}

/**
 * Summarise one path for the response.
 * @param {any} record
 */
function describePath(record) {
  const steps = pathToSteps(record.get('path'));
  const hops = fromNeoInt(record.get('hops')) ?? steps.length;

  const address = record.get('exchangeAddress');

  const amounts = steps.map((step) => step.amount).filter((n) => Number.isFinite(n) && n > 0);
  const temporalBreak = findTemporalBreak(steps);

  return {
    exchange: {
      address,
      addressDisplay: record.get('exchangeDisplay') ?? (address ? toChecksum(address) : null),
      exchange: record.get('exchangeName') ?? 'Unknown Exchange',
      label: record.get('exchangeLabel') ?? 'Unlabeled Exchange Address',
    },
    hops,
    /** What actually arrived at the exchange: the final transfer on this route. */
    amountIntoExchange: steps.length > 0 ? steps[steps.length - 1].amount : 0,
    assetIntoExchange: steps.length > 0 ? steps[steps.length - 1].asset : null,
    /**
     * The same final transfer in rough USD, used ONLY to rank routes against
     * each other. Two routes can end in different assets - 32,500 USDT against
     * 12 ETH - and comparing those raw numbers would rank the USDT route as
     * nearly three thousand times larger when it is actually smaller. The
     * reported figure stays `amountIntoExchange` in its own asset; this exists
     * so the ordering is not nonsense.
     */
    amountIntoExchangeUsdApprox:
      steps.length > 0 ? Number(approximateUsd(steps[steps.length - 1]).toFixed(2)) : 0,
    /**
     * The smallest transfer on the route. This upper-bounds how much of the
     * victim's money could have travelled the whole way, and is the honest
     * figure to quote - unlike a sum, which would count the same funds at
     * every hop.
     */
    bottleneckAmount: amounts.length > 0 ? Math.min(...amounts) : 0,
    firstSeenAt: steps.find((step) => step.timestamp !== null)?.timestamp ?? null,
    lastSeenAt: [...steps].reverse().find((step) => step.timestamp !== null)?.timestamp ?? null,
    temporallyOrdered: temporalBreak === -1,
    ...(temporalBreak === -1 ? {} : { temporalBreakAtHop: temporalBreak + 1 }),
    steps,
  };
}

/**
 * Look up the starting wallet and the graph's overall readiness in one round trip.
 *
 * Both facts are needed to tell the three "no result" cases apart, and asking for
 * them together avoids a second query on the empty path.
 *
 * @param {any} tx
 * @param {string} address
 */
async function readStartContext(tx, address) {
  const result = await tx.run(
    `
MATCH (w:Wallet { address: $address })
RETURN w.address        AS address,
       w.addressDisplay AS addressDisplay,
       w.isExchange     AS isExchange,
       w.exchange       AS exchange,
       w.riskScore      AS riskScore,
       w.minHopObserved AS minHopObserved,
       w.traceCount     AS traceCount,
       w.firstSeenAt    AS firstSeenAt,
       w.lastSeenAt     AS lastSeenAt,
       w.contractTag    AS contractTag
`.trim(),
    { address }
  );

  const exchangeCount = await tx.run(
    'MATCH (w:Wallet) WHERE w.isExchange = true RETURN count(w) AS total'
  );

  const record = result.records[0];

  return {
    exchangeWalletsInGraph: fromNeoInt(exchangeCount.records[0]?.get?.('total')) ?? 0,
    start: record
      ? {
          address: record.get('address'),
          addressDisplay: record.get('addressDisplay') ?? toChecksum(address),
          isExchange: Boolean(record.get('isExchange')),
          exchange: record.get('exchange') ?? null,
          riskScore: fromNeoInt(record.get('riskScore')) ?? null,
          minHopObserved: fromNeoInt(record.get('minHopObserved')) ?? null,
          traceCount: fromNeoInt(record.get('traceCount')) ?? null,
          firstSeenAt: record.get('firstSeenAt') ?? null,
          lastSeenAt: record.get('lastSeenAt') ?? null,
          contractTag: record.get('contractTag') ? JSON.parse(record.get('contractTag')) : null,
          inGraph: true,
        }
      : { address, addressDisplay: toChecksum(address), inGraph: false },
  };
}

/**
 * Pull one hop of surrounding context around the traced routes.
 *
 * Why bother: a peeling chain is recognisable by its shape - value arriving once
 * and leaving split across many addresses. A bare path is a line and shows none
 * of that. One hop of fan-out makes the behaviour visible while staying bounded.
 *
 * Exchange nodes are deliberately NOT expanded, for the same reason Phase 1
 * treats them as terminal: a Binance hot wallet has hundreds of thousands of
 * outgoing transfers and expanding it would bury the route we just found.
 *
 * @param {any} tx
 * @param {string[]} onPathAddresses
 * @param {number} limit
 */
async function readContextEdges(tx, onPathAddresses, limit) {
  if (onPathAddresses.length === 0) return [];

  const result = await tx.run(
    `
UNWIND $addresses AS addr
MATCH (w:Wallet { address: addr })-[t:TRANSACTION]-(n:Wallet)
WHERE coalesce(w.isExchange, false) = false
  AND coalesce(n.isExchange, false) = false
  AND NOT n.address IN $addresses
WITH startNode(t) AS src, endNode(t) AS dst, t
RETURN src.address        AS fromAddress,
       src.addressDisplay AS fromDisplay,
       src.contractTag    AS fromContractTag,
       dst.address        AS toAddress,
       dst.addressDisplay AS toDisplay,
       dst.isExchange     AS toIsExchange,
       dst.exchange       AS toExchange,
       dst.riskScore      AS toRiskScore,
       dst.contractTag    AS toContractTag,
       t.uniqueId       AS uniqueId,
       t.hash           AS hash,
       t.amount         AS amount,
       t.asset          AS asset,
       t.assetClass     AS assetClass,
       t.blockNumber    AS blockNumber,
       t.timestamp      AS timestamp,
       t.swapEvent      AS swapEvent
ORDER BY amount DESC
LIMIT $limit
`.trim(),
    { addresses: onPathAddresses, limit: toNeoInt(limit) }
  );

  return result.records.map((record) => ({
    from: record.get('fromAddress'),
    fromDisplay: record.get('fromDisplay') ?? toChecksum(record.get('fromAddress')),
    fromContractTag: record.get('fromContractTag') ? JSON.parse(record.get('fromContractTag')) : null,
    to: record.get('toAddress'),
    toDisplay: record.get('toDisplay') ?? toChecksum(record.get('toAddress')),
    toIsExchange: Boolean(record.get('toIsExchange')),
    toExchange: record.get('toExchange') ?? null,
    toRiskScore: fromNeoInt(record.get('toRiskScore')) ?? null,
    toContractTag: record.get('toContractTag') ? JSON.parse(record.get('toContractTag')) : null,
    uniqueId: record.get('uniqueId'),
    hash: record.get('hash'),
    amount: Number(fromNeoInt(record.get('amount')) ?? 0),
    asset: record.get('asset'),
    // `assetClass` is not decoration: without it every stablecoin edge here gets
    // priced as the native coin when nodes are sized, overstating an off-path
    // wallet by NATIVE_USD_HINT and making it the largest circle on the canvas.
    assetClass: record.get('assetClass') ?? null,
    blockNumber: fromNeoInt(record.get('blockNumber')) ?? null,
    timestamp: fromNeoInt(record.get('timestamp')) ?? null,
    swapEvent: record.get('swapEvent') ? JSON.parse(record.get('swapEvent')) : null,
  }));
}

/**
 * Find every shortest route from `address` to a flagged exchange.
 *
 * @param {string} rawAddress Victim-reported wallet. Any casing.
 * @param {object} [options]
 * @param {number} [options.maxHops=15]
 * @param {boolean} [options.includeContext=true] One hop of surrounding fan-out.
 * @param {number} [options.contextLimit=40]
 * @returns {Promise<object>}
 */
export async function findCashOutPaths(rawAddress, options = {}) {
  if (!config.graph.enabled) throw new GraphDisabledError();

  const address = normalizeAddress(rawAddress);
  const maxHops = assertHopBound(options.maxHops ?? DEFAULT_MAX_HOPS);
  const includeContext = options.includeContext !== false;
  const contextLimit = Math.min(
    Math.max(1, Math.trunc(Number(options.contextLimit ?? MAX_CONTEXT_EDGES))),
    MAX_CONTEXT_EDGES
  );

  const startedAt = Date.now();
  const cypher = buildShortestPathCypher(maxHops);

  return runInTransaction('READ', async (tx) => {
    const { start, exchangeWalletsInGraph } = await readStartContext(tx, address);
    const warnings = [];

    // --- The three distinct "no result" cases ------------------------------
    // Each has a different fix, so each gets its own reason rather than an
    // empty array that means whatever the reader assumes it means.

    if (!start.inGraph) {
      return emptyResult({
        address,
        start,
        maxHops,
        exchangeWalletsInGraph,
        startedAt,
        reason: 'WALLET_NOT_IN_GRAPH',
        message:
          `No wallet ${toChecksum(address)} exists in the graph, so there is nothing to trace ` +
          'from. This address has not been ingested yet.',
        hint: `Run the on-chain trace first: GET /api/history/${toChecksum(address)}?depth=3 - or call this endpoint without ?ingest=false and it will do that for you.`,
      });
    }

    if (exchangeWalletsInGraph === 0) {
      return emptyResult({
        address,
        start,
        maxHops,
        exchangeWalletsInGraph,
        startedAt,
        reason: 'NO_EXCHANGES_SEEDED',
        message:
          'No wallet in the graph is flagged isExchange, so no route can possibly be found. ' +
          'This is a setup gap, not a finding about this address.',
        hint: 'Run: npm run seed:exchanges',
      });
    }

    // --- The actual query --------------------------------------------------

    const result = await tx.run(cypher, { address });
    const paths = result.records.map(describePath);

    if (paths.length === 0) {
      return emptyResult({
        address,
        start,
        maxHops,
        exchangeWalletsInGraph,
        startedAt,
        reason: 'NO_ROUTE_FOUND',
        message:
          `No route of ${maxHops} hops or fewer connects ${start.addressDisplay} to a flagged ` +
          'exchange in the currently ingested data. The funds may still be sitting in an ' +
          'intermediary wallet, may have cashed out at an exchange not in the registry, or the ' +
          'trail may simply not have been ingested deeply enough.',
        hint:
          'Try a deeper on-chain trace (GET /api/history/:address?depth=5), raise ?maxHops, or ' +
          'check GET /api/graph/stats to confirm how much of this wallet\'s history is present.',
      });
    }

    // --- Rank --------------------------------------------------------------
    // Fewest hops first: a shorter route means fewer intermediaries and is the
    // stronger evidential link. Value breaks ties, so of two equally-close
    // exchanges the one that received more is named first.
    //
    // The tiebreak compares approximate USD rather than raw amounts, because the
    // two routes can end in different assets. Ranking 32,500 USDT above 12 ETH
    // on the numbers alone would be backwards, and it would be backwards
    // confidently, which is worse.
    paths.sort((a, b) => {
      if (a.hops !== b.hops) return a.hops - b.hops;
      if (b.amountIntoExchangeUsdApprox !== a.amountIntoExchangeUsdApprox) {
        return b.amountIntoExchangeUsdApprox - a.amountIntoExchangeUsdApprox;
      }
      // Final tiebreak on name, so repeated calls return an identical order and
      // the Phase 4 force layout does not reshuffle between reloads.
      return String(a.exchange.exchange ?? '').localeCompare(String(b.exchange.exchange ?? ''));
    });

    const outOfOrder = paths.filter((path) => !path.temporallyOrdered);
    if (outOfOrder.length > 0) {
      warnings.push(
        `${outOfOrder.length} of ${paths.length} route(s) contain a transfer that is older than ` +
          'the transfer feeding it, which is not physically possible for a single flow of funds. ' +
          'Those routes are real edges in the graph but are unlikely to be one laundering ' +
          'sequence - they are marked temporallyOrdered: false. Treat them as leads, not evidence.'
      );
    }

    // --- One hop of context ------------------------------------------------

    const onPath = new Set();
    for (const path of paths) {
      for (const step of path.steps) {
        if (step.from) onPath.add(step.from);
        if (step.to) onPath.add(step.to);
      }
    }
    onPath.add(address);

    const contextEdges = includeContext
      ? await readContextEdges(tx, [...onPath].sort(), contextLimit)
      : [];

    if (includeContext && contextEdges.length === contextLimit) {
      warnings.push(
        `Surrounding context was capped at ${contextLimit} edges. The traced routes are complete; ` +
          'only the extra fan-out shown around them is truncated.'
      );
    }

    const uniqueSwaps = new Set();
    for (const path of paths) {
      for (const step of path.steps) {
        if (step.swapEvent && step.uniqueId) uniqueSwaps.add(step.uniqueId);
      }
    }
    for (const edge of contextEdges) {
      if (edge.swapEvent && edge.uniqueId) uniqueSwaps.add(edge.uniqueId);
    }

    const crossChainMap = new Map();
    for (const path of paths) {
      for (const step of path.steps) {
        if (step.toContractTag?.type === 'bridge' && Array.isArray(step.toContractTag.destinationChains)) {
          for (const chain of step.toContractTag.destinationChains) {
            crossChainMap.set(`${chain}:${step.to}`, { chain, address: step.to, viaBridge: step.toContractTag.name });
          }
        }
      }
    }

    // Query BRIDGED_TO relationships created by cross-chain reconciliation engine in Neo4j
    const bridgedEdgesResult = await tx.run(
      `
      UNWIND $addresses AS addr
      MATCH (w:Wallet) WHERE toLower(w.address) = toLower(addr)
      MATCH (w)-[r:BRIDGED_TO]->(b:Wallet)
      RETURN w.address          AS fromAddress,
             w.addressDisplay   AS fromDisplay,
             b.address          AS toAddress,
             b.addressDisplay   AS toDisplay,
             r.bridge           AS bridgeProtocol,
             r.confidence       AS confidence,
             r.usdIn            AS usdIn,
             r.usdOut           AS usdOut,
             r.timeDelta        AS timeDelta
      `.trim(),
      { addresses: [...onPath] }
    );

    for (const rec of bridgedEdgesResult.records) {
      const fromAddr = rec.get('fromAddress');
      const toAddr = rec.get('toAddress');
      const bridge = rec.get('bridgeProtocol');

      crossChainMap.set(`bridge:${fromAddr}:${toAddr}`, {
        chain: bridge || 'cross-chain',
        address: toAddr,
        viaBridge: bridge,
        fromAddress: fromAddr,
        confidence: rec.get('confidence'),
        usdIn: rec.get('usdIn'),
        usdOut: rec.get('usdOut'),
      });

      contextEdges.push({
        from: fromAddr,
        fromDisplay: rec.get('fromDisplay') ?? toChecksum(fromAddr),
        to: toAddr,
        toDisplay: rec.get('toDisplay') ?? toChecksum(toAddr),
        toIsExchange: false,
        toExchange: null,
        uniqueId: `bridge:${fromAddr}:${toAddr}`,
        hash: `bridge-${fromAddr.slice(0, 8)}-${toAddr.slice(0, 8)}`,
        amount: Number(rec.get('usdIn') || 0),
        asset: 'BRIDGED',
        assetClass: 'bridge',
        blockNumber: null,
        timestamp: null,
        isBridge: true,
        bridgeProtocol: bridge,
      });
    }

    const crossChain = [...crossChainMap.values()];

    logger.info('Cash-out paths resolved', {
      address: start.addressDisplay,
      paths: paths.length,
      shortest: paths[0]?.hops,
      exchange: paths[0]?.exchange?.exchange,
      durationMs: Date.now() - startedAt,
    });

    return {
      found: true,
      query: {
        address,
        addressDisplay: start.addressDisplay,
        maxHops,
        includeContext,
      },
      start,
      /** The headline answer: nearest exchange, value breaking ties. */
      topExchange: paths[0].exchange,
      shortestHops: paths[0].hops,
      paths,
      contextEdges,
      crossChain,
      stats: {
        pathsFound: paths.length,
        exchangesReached: new Set(paths.map((p) => p.exchange.address)).size,
        exchangeWalletsInGraph,
        contextEdges: contextEdges.length,
        temporallyInconsistentPaths: outOfOrder.length,
        swapsDetected: uniqueSwaps.size,
        durationMs: Date.now() - startedAt,
      },
      warnings,
    };
  });
}

/**
 * Shape a "nothing found" answer so it carries the same envelope as a hit.
 *
 * `found: false` with a machine-readable `reason` lets the Phase 4 UI show a
 * useful empty state instead of an ambiguous blank canvas.
 */
function emptyResult({
  address,
  start,
  maxHops,
  exchangeWalletsInGraph,
  startedAt,
  reason,
  message,
  hint,
}) {
  logger.info('No cash-out path found', { address, reason });

  return {
    found: false,
    reason,
    message,
    hint,
    query: { address, addressDisplay: start.addressDisplay, maxHops },
    start,
    topExchange: null,
    shortestHops: null,
    paths: [],
    contextEdges: [],
    crossChain: [],
    stats: {
      pathsFound: 0,
      exchangesReached: 0,
      exchangeWalletsInGraph,
      contextEdges: 0,
      temporallyInconsistentPaths: 0,
      swapsDetected: 0,
      durationMs: Date.now() - startedAt,
    },
    warnings: [],
  };
}

/**
 * PHASE 2B: Find the shortest path directly from a victim wallet to a suspect wallet.
 * This is fundamentally different from finding any exchange.
 */
export async function findDirectPath(victimWallet, suspectWallet, maxHops = DEFAULT_MAX_HOPS) {
  const bound = assertHopBound(maxHops);
  const vAddr = normalizeAddress(victimWallet);
  const sAddr = normalizeAddress(suspectWallet);

  const query = `
    MATCH (start:Wallet { address: $vAddr })
    MATCH (target:Wallet { address: $sAddr })
    MATCH path = shortestPath((start)-[:TRANSACTION*1..${bound}]->(target))
    RETURN path AS path, length(path) AS hops
  `;

  let result = null;
  
  try {
    await runInTransaction('READ', async (tx) => {
      const dbResult = await tx.run(query, { vAddr, sAddr });
      if (dbResult.records.length > 0) {
        const record = dbResult.records[0];
        const steps = pathToSteps(record.get('path'));
        result = {
          found: true,
          hops: fromNeoInt(record.get('hops')),
          path: steps,
          temporalBreak: findTemporalBreak(steps)
        };
      }
    });
  } catch (error) {
    if (!(error instanceof GraphDisabledError)) {
      logger.error('Failed to run direct path check', { error: error.message });
    }
    return { found: false, error: 'Database unavailable' };
  }

  if (!result) return { found: false, reason: 'no_path' };
  return result;
}
