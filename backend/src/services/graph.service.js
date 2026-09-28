/**
 * services/graph.service.js
 * ---------------------------------------------------------------------------
 * PHASE 2 CORE: `ingestToGraph(transactions)`
 *
 * Takes the flat output of Phase 1's `fetchWalletHistory` and MERGEs it into
 * Neo4j as `Wallet` nodes joined by `TRANSACTION` relationships.
 *
 * ===========================================================================
 * WHY MERGE AND NOT CREATE
 * ===========================================================================
 * Two traces overlap constantly - that is the entire point of a graph. Trace
 * victim A and you find a launder wallet; trace victim B a week later and you
 * find the same wallet. With CREATE you would get two nodes for one address and
 * the connection between the two victims - the single most valuable finding the
 * system can produce - would be invisible.
 *
 * MERGE gives us idempotent, additive ingestion instead: re-running the same
 * trace changes nothing, and every new trace enriches the graph. That is also
 * why the endpoint can auto-ingest on every request without accumulating junk.
 *
 * ===========================================================================
 * WHY BATCHED UNWIND
 * ===========================================================================
 * A 400-address trace produces a few thousand edges. Written one query at a
 * time that is a few thousand network round trips, each with transaction
 * overhead - slow enough to be visible on stage. `UNWIND $rows AS row` sends one
 * batch as a single parameter and lets Cypher loop server-side, turning
 * thousands of round trips into a handful.
 *
 * Batching also bounds transaction size. One enormous transaction holds its
 * whole undo log in memory, and Neo4j's default heap is not generous.
 *
 * ===========================================================================
 * ON CREATE vs ON MATCH
 * ===========================================================================
 * The property-merge rules below are deliberate, and one of them is important:
 *
 *   w.isExchange = (coalesce(w.isExchange, false) OR row.isExchange)
 *
 * `isExchange` is sticky-true: once an address is known to be an exchange, no
 * later ingest can un-flag it. Phase 3 finds cash-out points by targeting
 * `isExchange = true`, so a false negative here does not degrade the answer -
 * it deletes it. The trace would report "no exchange found" for funds that
 * demonstrably reached one. Sticky-true makes that failure mode impossible.
 */

import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isValidAddress, toChecksum, normalizeAddress } from '../lib/addresses.js';
import {
  runInTransaction,
  extractCounters,
  toNeoInt,
  fromNeoInt,
  GraphDisabledError,
} from './neo4j.service.js';
import { applyGraphSchema } from './graphSchema.js';

// --- Risk scoring ----------------------------------------------------------

/**
 * Human-readable description of the risk model, exposed via `/api/config` so
 * the Phase 4 UI can render an honest legend instead of an unexplained number.
 */
export const RISK_MODEL = Object.freeze({
  version: 1,
  description:
    'Heuristic 0-100 score. Proximity to the reported wallet dominates; layering ' +
    'and pass-through behaviour add to it. Known exchanges score low because they ' +
    'are identified, regulated destinations rather than suspects.',
  factors: Object.freeze([
    'Base: 100 at the reported address, falling 20 per hop, floor 10.',
    'Known exchange: fixed 5 - a destination to report, not a wallet to suspect.',
    '+10 layering: 3 or more outgoing recipients from a single inbound transfer.',
    '+10 pass-through: forwards 90% or more of what it received.',
  ]),
});

/**
 * Score a wallet 0-100.
 *
 * This is openly a heuristic, not a model. It exists because your schema has a
 * `riskScore` property and leaving it null would make the field decorative. It
 * is cheap, explainable in one sentence to a judge, and easy to replace with
 * something learned later - which is exactly what you want at this stage.
 *
 * @param {{ hop?: number, isExchange?: boolean, inboundCount?: number,
 *   outboundCount?: number, inboundValue?: number, outboundValue?: number }} wallet
 * @returns {number} Integer 0-100.
 */
export function computeRiskScore(wallet) {
  // A known exchange is the answer, not a suspect. Scoring it high would make
  // the Phase 4 heat map light up on precisely the nodes that are legitimate.
  if (wallet.isExchange) return 5;

  const hop = Number.isFinite(wallet.hop) ? wallet.hop : 0;
  let score = Math.max(10, 100 - hop * 20);

  const inboundCount = wallet.inboundCount ?? 0;
  const outboundCount = wallet.outboundCount ?? 0;
  const inboundValue = wallet.inboundValue ?? 0;
  const outboundValue = wallet.outboundValue ?? 0;

  // Layering: money arrives once and leaves split across several addresses.
  // This is the signature of a peeling chain.
  if (outboundCount >= 3 && inboundCount <= 1) score += 10;

  // Pass-through: the wallet keeps almost nothing, so it is a conduit rather
  // than a destination. Real user wallets tend to retain a balance.
  if (inboundValue > 0 && outboundValue >= inboundValue * 0.9) score += 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// --- Cypher ----------------------------------------------------------------

/**
 * Upsert wallet nodes.
 *
 * `minHopObserved` is named carefully. Hop distance is relative to whichever
 * address was traced, so it is not a property of the wallet itself; what IS
 * meaningful across traces is the closest we have ever seen this wallet sit to a
 * victim-reported address. Calling it `hop` would have implied more than it
 * means.
 */
export const WALLET_MERGE_CYPHER = `
UNWIND $rows AS row
MERGE (w:Wallet { address: row.address })
ON CREATE SET
  w.addressDisplay = row.addressDisplay,
  w.isExchange     = row.isExchange,
  w.exchange       = row.exchange,
  w.exchangeLabel  = row.exchangeLabel,
  w.riskScore      = row.riskScore,
  w.minHopObserved = row.hop,
  w.chain          = row.chain,
  w.contractTag    = row.contractTag,
  w.firstSeenAt    = row.ingestedAt,
  w.lastSeenAt     = row.ingestedAt,
  w.traceCount     = 1
ON MATCH SET
  w.addressDisplay = coalesce(w.addressDisplay, row.addressDisplay),
  w.isExchange     = (coalesce(w.isExchange, false) OR row.isExchange),
  w.exchange       = coalesce(w.exchange, row.exchange),
  w.exchangeLabel  = coalesce(w.exchangeLabel, row.exchangeLabel),
  w.riskScore      = CASE WHEN row.riskScore > coalesce(w.riskScore, 0)
                          THEN row.riskScore ELSE w.riskScore END,
  w.minHopObserved = CASE WHEN row.hop < coalesce(w.minHopObserved, 999)
                          THEN row.hop ELSE w.minHopObserved END,
  w.chain          = coalesce(w.chain, row.chain),
  w.contractTag    = row.contractTag,
  w.lastSeenAt     = row.ingestedAt,
  w.traceCount     = coalesce(w.traceCount, 0) + 1
`.trim();

/**
 * Upsert transaction edges, creating either endpoint if it is missing.
 *
 * The two wallet MERGEs are a safety net. `ingestToGraph` writes the wallet
 * batch first, so they normally match immediately - but the roadmap signature is
 * `ingestToGraph(transactions)` with no wallet list, and that call has to
 * produce a correct graph too. Endpoints created here get conservative defaults
 * and are enriched by any later ingest that knows more about them.
 */
export const TRANSACTION_MERGE_CYPHER = `
UNWIND $rows AS row
MERGE (sender:Wallet { address: row.from })
  ON CREATE SET sender.addressDisplay = row.fromDisplay,
                sender.isExchange     = false,
                sender.riskScore      = 0,
                sender.chain          = row.chain,
                sender.firstSeenAt    = row.ingestedAt,
                sender.lastSeenAt     = row.ingestedAt,
                sender.traceCount     = 1
MERGE (recipient:Wallet { address: row.to })
  ON CREATE SET recipient.addressDisplay = row.toDisplay,
                recipient.isExchange     = false,
                recipient.riskScore      = 0,
                recipient.chain          = row.chain,
                recipient.firstSeenAt    = row.ingestedAt,
                recipient.lastSeenAt     = row.ingestedAt,
                recipient.traceCount     = 1
MERGE (sender)-[t:TRANSACTION { uniqueId: row.uniqueId }]->(recipient)
ON CREATE SET
  t.hash        = row.hash,
  t.amount      = row.amount,
  t.asset       = row.asset,
  t.assetClass  = row.assetClass,
  t.contract    = row.contract,
  t.timestamp   = row.timestamp,
  t.blockNumber = row.blockNumber,
  t.category    = row.category,
  t.hop         = row.hop,
  t.chain       = row.chain,
  t.swapEvent   = row.swapEvent,
  t.ingestedAt  = row.ingestedAt
ON MATCH SET
  t.lastSeenAt  = row.ingestedAt,
  t.hop         = CASE WHEN row.hop < coalesce(t.hop, 999) THEN row.hop ELSE t.hop END
`.trim();

// --- Helpers ---------------------------------------------------------------

/**
 * Split an array into fixed-size chunks.
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Merge two counter objects. */
function addCounters(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

/**
 * Build the parameter row for one wallet.
 * @param {any} wallet
 * @param {string} ingestedAt
 */
function toWalletRow(wallet, ingestedAt) {
  return {
    address: wallet.address,
    addressDisplay: wallet.addressDisplay ?? toChecksum(wallet.address),
    isExchange: Boolean(wallet.isExchange),
    exchange: wallet.exchangeName ?? wallet.exchange ?? null,
    exchangeLabel: wallet.exchangeLabel ?? null,
    // Integer per the schema, not a Float. See toNeoInt's docstring.
    riskScore: toNeoInt(computeRiskScore(wallet)),
    hop: toNeoInt(wallet.hop ?? 0),
    chain: wallet.chain ?? config.network,
    contractTag: wallet.contractTag ? JSON.stringify(wallet.contractTag) : null,
    ingestedAt,
  };
}

/**
 * Build the parameter row for one transaction.
 * @param {any} transfer
 * @param {string} ingestedAt
 */
function toTransactionRow(transfer, ingestedAt) {
  return {
    uniqueId: transfer.uniqueId,
    hash: transfer.hash,
    from: transfer.from,
    to: transfer.to,
    fromDisplay: toChecksum(transfer.from),
    toDisplay: toChecksum(transfer.to),
    // `amount` stays a JS number: the schema types it Float, which is correct
    // for a decimal quantity.
    amount: transfer.amount,
    asset: transfer.asset,
    assetClass: transfer.assetClass ?? null,
    contract: transfer.contract ?? null,
    // Integers, so Neo4j stores them as Integer rather than Float.
    timestamp: toNeoInt(transfer.timestamp),
    blockNumber: toNeoInt(transfer.blockNumber),
    category: transfer.category ?? 'external',
    hop: toNeoInt(transfer.hop ?? 0),
    chain: transfer.chain ?? config.network,
    swapEvent: transfer.swapEvent ? JSON.stringify(transfer.swapEvent) : null,
    ingestedAt,
  };
}

/**
 * Reject rows that would corrupt the graph, and say why.
 *
 * Better to drop three malformed rows with a warning than to write a node whose
 * address is `undefined` and spend the evening wondering where it came from.
 *
 * @param {any[]} transactions
 * @returns {{ valid: any[], rejected: Array<{ reason: string, uniqueId?: string }> }}
 */
function partitionTransactions(transactions) {
  const valid = [];
  const rejected = [];

  for (const transfer of transactions) {
    if (!transfer || typeof transfer !== 'object') {
      rejected.push({ reason: 'not-an-object' });
      continue;
    }
    if (!transfer.uniqueId) {
      rejected.push({ reason: 'missing-uniqueId', uniqueId: undefined });
      continue;
    }
    if (!isValidAddress(transfer.from) || !isValidAddress(transfer.to)) {
      rejected.push({ reason: 'invalid-address', uniqueId: transfer.uniqueId });
      continue;
    }
    if (transfer.from === transfer.to) {
      // Self-transfers are noise, and a self-loop renders badly in the Phase 4
      // force graph. Phase 1 filters these already; this is belt and braces.
      rejected.push({ reason: 'self-loop', uniqueId: transfer.uniqueId });
      continue;
    }
    if (!Number.isFinite(transfer.amount)) {
      rejected.push({ reason: 'non-numeric-amount', uniqueId: transfer.uniqueId });
      continue;
    }
    valid.push(transfer);
  }

  return { valid, rejected };
}

// --- The main entry point --------------------------------------------------

/**
 * Write a trace into Neo4j.
 *
 * Accepts three call shapes, because the roadmap specifies the first and the
 * other two are what the rest of the codebase naturally has to hand:
 *
 *   ingestToGraph(transactions)
 *   ingestToGraph(transactions, wallets)
 *   ingestToGraph(traceResult)            // the object fetchWalletHistory returns
 *
 * @param {any[]|{ transactions: any[], wallets?: any[] }} transactionsOrTrace
 * @param {any[]} [wallets]
 * @param {{ ensureSchema?: boolean }} [options]
 * @returns {Promise<{
 *   ok: boolean, walletsWritten: number, transactionsWritten: number,
 *   nodesCreated: number, relationshipsCreated: number, propertiesSet: number,
 *   batches: number, rejected: Array<{reason: string, uniqueId?: string}>,
 *   durationMs: number, warnings: string[]
 * }>}
 */
export async function ingestToGraph(transactionsOrTrace, wallets = [], options = {}) {
  const startedAt = Date.now();

  if (!config.graph.enabled) throw new GraphDisabledError();

  // --- Normalise the arguments --------------------------------------------
  let transactions = transactionsOrTrace;
  let walletList = wallets;

  if (transactionsOrTrace && !Array.isArray(transactionsOrTrace)) {
    // Reject primitives explicitly. Reading `.transactions` off a number or a
    // string yields undefined, which would fall through to the empty-input path
    // and report a successful "nothing to ingest" - so a caller who passed, say,
    // an unparsed JSON string would believe their trace had been persisted. A
    // wrong argument must be loud, because nothing downstream can detect it.
    if (typeof transactionsOrTrace !== 'object') {
      throw new TypeError(
        `ingestToGraph expected an array of transactions or the object returned by ` +
          `fetchWalletHistory, but received ${typeof transactionsOrTrace}.`
      );
    }

    // An object is only a trace if it actually carries one of the two keys.
    if (
      !Array.isArray(transactionsOrTrace.transactions) &&
      !Array.isArray(transactionsOrTrace.wallets)
    ) {
      throw new TypeError(
        'ingestToGraph received an object with neither a `transactions` nor a `wallets` ' +
          'array. Pass the value returned by fetchWalletHistory, or an array of transfers.'
      );
    }

    transactions = transactionsOrTrace.transactions ?? [];
    // An explicit second argument still wins, so the trace object is a
    // convenience rather than a constraint.
    if (walletList.length === 0) walletList = transactionsOrTrace.wallets ?? [];
  }

  if (!Array.isArray(transactions)) {
    // Reached by null/undefined. Treating those as "nothing to ingest" would be
    // friendlier and wrong: an empty trace is `[]`, whereas null usually means the
    // caller read a property that does not exist. Only one of those should be
    // silent.
    throw new TypeError(
      'ingestToGraph received no transactions. Pass an array of transfers (use [] for an ' +
        'empty trace) or the object returned by fetchWalletHistory.'
    );
  }

  // `wallets` is caller-supplied too, and a non-array here would throw much later
  // inside the row builder with a far less helpful message.
  if (!Array.isArray(walletList)) {
    throw new TypeError('ingestToGraph expects `wallets` to be an array when provided.');
  }

  /** @type {string[]} */
  const warnings = [];

  // --- Empty input is a normal outcome, not an error ----------------------
  // A freshly created or inbound-only wallet legitimately has nothing to write.
  // Returning a clean zero result keeps that out of the error path, where it
  // would look like a failure in the UI.
  if (transactions.length === 0 && walletList.length === 0) {
    return {
      ok: true,
      walletsWritten: 0,
      transactionsWritten: 0,
      nodesCreated: 0,
      relationshipsCreated: 0,
      propertiesSet: 0,
      batches: 0,
      rejected: [],
      durationMs: Date.now() - startedAt,
      warnings: ['Nothing to ingest: the trace produced no wallets or transactions.'],
    };
  }

  // --- Make sure the schema exists ----------------------------------------
  // Without the uniqueness constraint on Wallet.address, every MERGE degrades
  // into a full label scan and ingestion gets quadratically slower as the graph
  // grows. Cheap to assert, expensive to forget.
  if (options.ensureSchema !== false && config.graph.autoMigrate) {
    const schema = await applyGraphSchema();
    for (const skipped of schema.skipped) {
      if (skipped.name === 'transaction_unique_id') {
        warnings.push(
          'Neo4j did not accept the relationship uniqueness constraint on ' +
            'TRANSACTION.uniqueId; edge uniqueness is still enforced by MERGE.'
        );
      }
    }
  }

  const ingestedAt = new Date().toISOString();
  const { valid, rejected } = partitionTransactions(transactions);

  if (rejected.length > 0) {
    warnings.push(`Skipped ${rejected.length} malformed transaction row(s) during ingestion.`);
    logger.warn('Rejected transaction rows during ingestion', {
      count: rejected.length,
      reasons: [...new Set(rejected.map((r) => r.reason))],
    });
  }

  // --- Build parameter rows -----------------------------------------------
  //
  // Sorting is not cosmetic. Concurrent transactions that lock the same wallets
  // in different orders can deadlock; a deterministic order makes that far less
  // likely. The residual risk is handled by the driver, which retries deadlocks
  // automatically - see runInTransaction.
  const walletRows = walletList
    .filter((wallet) => wallet && isValidAddress(wallet.address))
    .map((wallet) => toWalletRow(wallet, ingestedAt))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const transactionRows = valid
    .map((transfer) => toTransactionRow(transfer, ingestedAt))
    .sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      return a.uniqueId < b.uniqueId ? -1 : a.uniqueId > b.uniqueId ? 1 : 0;
    });

  const counters = {};
  let batchesAttempted = 0;
  let batchesSucceeded = 0;
  let ok = true;

  // --- Write wallets, then edges ------------------------------------------
  // Order matters: creating the nodes first means the edge query almost always
  // takes its MERGE match path, which is measurably cheaper than create-on-miss.
  const batchSize = config.graph.batchSize;
  const chunkedWallets = chunk(walletRows, batchSize);
  const chunkedTransactions = chunk(transactionRows, batchSize);
  const totalBatches = chunkedWallets.length + chunkedTransactions.length;
  let currentBatch = 0;
  
  try {
    for (const rows of chunkedWallets) {
      batchesAttempted += 1;
      currentBatch += 1;
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: 'wallets',
          batch: currentBatch,
          totalBatches,
          count: rows.length,
        });
      }
      const result = await runInTransaction('WRITE', async (tx) => tx.run(WALLET_MERGE_CYPHER, { rows }));
      addCounters(counters, extractCounters(result));
      batchesSucceeded += 1;
    }

    for (const rows of chunkedTransactions) {
      batchesAttempted += 1;
      currentBatch += 1;
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: 'transactions',
          batch: currentBatch,
          totalBatches,
          count: rows.length,
        });
      }
      const result = await runInTransaction('WRITE', async (tx) =>
        tx.run(TRANSACTION_MERGE_CYPHER, { rows })
      );
      addCounters(counters, extractCounters(result));
      batchesSucceeded += 1;
    }
  } catch (error) {
    ok = false;
    warnings.push(`Graph ingestion failed mid-batch: ${error.message}`);
    logger.error('Graph ingestion partial failure', { 
      batchesAttempted, 
      batchesSucceeded, 
      error: error.message 
    });
  }

  const durationMs = Date.now() - startedAt;

  const summary = {
    ok,
    walletsWritten: walletRows.length,
    transactionsWritten: transactionRows.length,
    nodesCreated: counters.nodesCreated ?? 0,
    relationshipsCreated: counters.relationshipsCreated ?? 0,
    propertiesSet: counters.propertiesSet ?? 0,
    batchesAttempted,
    batchesSucceeded,
    rejected,
    durationMs,
    warnings,
  };

  logger.info('Graph ingestion complete', {
    walletsWritten: summary.walletsWritten,
    transactionsWritten: summary.transactionsWritten,
    nodesCreated: summary.nodesCreated,
    relationshipsCreated: summary.relationshipsCreated,
    // A re-run of the same trace should show 0 created and non-zero written.
    // That is the visible proof that MERGE is doing its job.
    batchesAttempted,
    batchesSucceeded,
    durationMs,
  });

  return summary;
}

/**
 * MERGE exchange hot wallets as `isExchange: true` nodes.
 *
 * Separate from `ingestToGraph` because seeding is reference data, not
 * observation: these nodes exist whether or not any traced money touched them,
 * and they must be present *before* a trace runs so that Phase 3's shortestPath
 * has something to aim at.
 *
 * @param {Array<{address: string, exchange: string, label: string, walletType?: string, chain?: string}>} exchanges
 * @returns {Promise<{ seeded: number, nodesCreated: number, propertiesSet: number, skipped: string[] }>}
 */
export async function seedExchangeWallets(exchanges) {
  if (!config.graph.enabled) throw new GraphDisabledError();

  const skipped = [];
  const seededAt = new Date().toISOString();

  const rows = [];
  for (const entry of exchanges) {
    if (!entry || !isValidAddress(entry.address)) {
      skipped.push(`${entry?.exchange ?? 'unknown'} (${entry?.address ?? 'no address'})`);
      continue;
    }
    rows.push({
      address: normalizeAddress(entry.address),
      addressDisplay: toChecksum(entry.address),
      exchange: entry.exchange,
      exchangeLabel: entry.label ?? null,
      walletType: entry.walletType ?? 'unknown',
      chain: entry.chain ?? config.network,
      seededAt,
    });
  }

  if (rows.length === 0) {
    return { seeded: 0, nodesCreated: 0, propertiesSet: 0, skipped };
  }

  rows.sort((a, b) => (a.address < b.address ? -1 : 1));

  // Note `isExchange = true` in BOTH branches, unlike the trace ingest. Seeding
  // is authoritative: if this address is in the registry it is an exchange, and
  // an earlier trace that created the node as a plain wallet must be corrected.
  const evmRows = rows.filter(r => !r.chain.startsWith('btc'));
  const btcRows = rows.filter(r => r.chain.startsWith('btc'));

  const evmCypher = `
UNWIND $rows AS row
MERGE (w:Wallet { address: row.address })
ON CREATE SET
  w.addressDisplay = row.addressDisplay,
  w.isExchange     = true,
  w.exchange       = row.exchange,
  w.exchangeLabel  = row.exchangeLabel,
  w.walletType     = row.walletType,
  w.chain          = row.chain,
  w.riskScore      = 5,
  w.seededAt       = row.seededAt,
  w.firstSeenAt    = row.seededAt,
  w.lastSeenAt     = row.seededAt,
  w.traceCount     = 0
ON MATCH SET
  w.addressDisplay = row.addressDisplay,
  w.isExchange     = true,
  w.exchange       = row.exchange,
  w.exchangeLabel  = row.exchangeLabel,
  w.walletType     = row.walletType,
  w.chain          = row.chain,
  w.riskScore      = 5,
  w.seededAt       = row.seededAt
RETURN count(w) AS seeded
`.trim();

  // For BTC, the exchange entity is the BtcCluster.
  // We seed the cluster and an associated BtcAddress to link them.
  const btcCypher = `
UNWIND $rows AS row
MERGE (c:BtcCluster { clusterId: row.address })
ON CREATE SET
  c.isExchange = true,
  c.exchange = row.exchange,
  c.exchangeLabel = row.exchangeLabel,
  c.walletType = row.walletType,
  c.seededAt = row.seededAt
ON MATCH SET
  c.isExchange = true,
  c.exchange = row.exchange,
  c.exchangeLabel = row.exchangeLabel,
  c.walletType = row.walletType,
  c.seededAt = row.seededAt
MERGE (a:BtcAddress { address: row.address })
MERGE (a)-[:BELONGS_TO]->(c)
RETURN count(c) AS seeded
`.trim();

  const counters = {};
  let seeded = 0;

  for (const batch of chunk(evmRows, config.graph.batchSize)) {
    const result = await runInTransaction('WRITE', async (tx) => tx.run(evmCypher, { rows: batch }));
    addCounters(counters, extractCounters(result));
    seeded += fromNeoInt(result.records?.[0]?.get?.('seeded')) ?? batch.length;
  }
  
  for (const batch of chunk(btcRows, config.graph.batchSize)) {
    const result = await runInTransaction('WRITE', async (tx) => tx.run(btcCypher, { rows: batch }));
    addCounters(counters, extractCounters(result));
    seeded += fromNeoInt(result.records?.[0]?.get?.('seeded')) ?? batch.length;
  }

  return {
    seeded,
    nodesCreated: counters.nodesCreated ?? 0,
    propertiesSet: counters.propertiesSet ?? 0,
    skipped,
  };
}

/**
 * Summary statistics for the whole graph.
 *
 * Deliberately several small queries rather than one clever one with CALL
 * subqueries: the subquery syntax shifted between Neo4j 5 minors, and three
 * counted queries against an indexed graph are milliseconds anyway.
 *
 * @returns {Promise<object>}
 */
export async function getGraphStats() {
  if (!config.graph.enabled) throw new GraphDisabledError();

  return runInTransaction('READ', async (tx) => {
    const walletResult = await tx.run('MATCH (w:Wallet) RETURN count(w) AS total');
    const exchangeResult = await tx.run(
      'MATCH (w:Wallet) WHERE w.isExchange = true RETURN count(w) AS total'
    );
    const edgeResult = await tx.run('MATCH ()-[t:TRANSACTION]->() RETURN count(t) AS total');

    // Where the money actually landed. This is the query that answers the
    // problem statement at database level, independent of any single trace.
    const topExchangeResult = await tx.run(`
MATCH (:Wallet)-[t:TRANSACTION]->(e:Wallet)
WHERE e.isExchange = true
RETURN e.address        AS address,
       e.addressDisplay AS addressDisplay,
       e.exchange       AS exchange,
       e.exchangeLabel  AS label,
       count(t)         AS transfers,
       sum(t.amount)    AS received
ORDER BY received DESC
LIMIT 10
`.trim());

    const assetResult = await tx.run(`
MATCH ()-[t:TRANSACTION]->()
RETURN t.asset AS asset, count(t) AS transfers, sum(t.amount) AS total
ORDER BY transfers DESC
`.trim());

    const lastIngestResult = await tx.run(
      'MATCH ()-[t:TRANSACTION]->() RETURN max(t.ingestedAt) AS lastIngestedAt'
    );

    /** @param {any} record @param {string} key */
    const num = (record, key) => fromNeoInt(record?.get?.(key)) ?? 0;

    const totalsByAsset = {};
    for (const record of assetResult.records) {
      const asset = record.get('asset') ?? 'unknown';
      totalsByAsset[asset] = {
        transfers: num(record, 'transfers'),
        total: Number((fromNeoInt(record.get('total')) ?? 0).toFixed(6)),
      };
    }

    return {
      wallets: num(walletResult.records[0], 'total'),
      exchangeWallets: num(exchangeResult.records[0], 'total'),
      transactions: num(edgeResult.records[0], 'total'),
      lastIngestedAt: lastIngestResult.records[0]?.get?.('lastIngestedAt') ?? null,
      totalsByAsset,
      topExchanges: topExchangeResult.records.map((record) => ({
        address: record.get('address'),
        addressDisplay: record.get('addressDisplay'),
        exchange: record.get('exchange'),
        label: record.get('label'),
        transfers: num(record, 'transfers'),
        received: Number((fromNeoInt(record.get('received')) ?? 0).toFixed(6)),
      })),
      database: config.graph.database,
    };
  });
}
