/**
 * routes/history.routes.js
 * ---------------------------------------------------------------------------
 * Phase 1 + Phase 2 HTTP surface.
 *
 *   GET /api/history/:address?depth=3   run a trace AND write it to Neo4j
 *   GET /api/config                     what this server is configured to do
 *
 * Note on naming: this is `/api/history`, not `/api/trace`. Phase 3 introduces
 * `GET /api/trace/:address`, which serves a different purpose - it answers from
 * the Neo4j graph via shortestPath. Keeping the two separate is useful, because
 * `/api/history` is your ingestion-and-diagnostics endpoint (did we actually pull
 * the right data off-chain, and did it land in the graph?) while `/api/trace` is
 * the analytical answer. When a trace looks wrong you will want to know which of
 * the two stages is at fault.
 *
 * ---------------------------------------------------------------------------
 * PHASE 2: AUTO-INGESTION, AND WHY IT CANNOT FAIL THE REQUEST
 * ---------------------------------------------------------------------------
 * Every successful trace is written to Neo4j before the response is sent, so a
 * single call both fetches and persists - paste an address, and Phase 3's graph
 * query has data to work with immediately.
 *
 * Ingestion failures are reported, never thrown. The chain data has already been
 * fetched at that point, and it is the expensive, rate-limited, hard-to-get half
 * of the work. Discarding it because the database is asleep would be the wrong
 * trade every time. So the response carries `graph.ok: false` with the reason,
 * and the trace itself still renders.
 */

import { Router } from 'express';

import { config } from '../config/env.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { validateAddressParam } from '../middleware/validateAddress.js';
import { fetchWalletHistory } from '../services/walletHistory.service.js';
import { describeTrackedAssets } from '../services/assetTransfers.js';
import { listKnownExchanges, unverifiedExchanges } from '../config/knownExchanges.js';
import { ingestToGraph, RISK_MODEL } from '../services/graph.service.js';
import { logger } from '../lib/logger.js';

export const historyRouter = Router();

/**
 * Wall-clock ceiling for one trace. A wide trace on mainnet with backoff can
 * legitimately take a while, but an unbounded request that hangs for four
 * minutes during a demo is worse than a clean timeout with a usable message.
 */
const TRACE_TIMEOUT_MS = 90_000;

/**
 * Write a completed trace into Neo4j, converting any failure into a reportable
 * result rather than an exception.
 *
 * @param {import('../services/walletHistory.service.js').WalletNode[]} wallets
 * @param {any[]} transactions
 * @returns {Promise<object>} A `graph` block for the response body.
 */
async function ingestQuietly(wallets, transactions) {
  if (!config.graph.enabled) {
    return {
      ok: false,
      enabled: false,
      skipped: true,
      reason: 'GRAPH_ENABLED=false, so this trace was not persisted.',
    };
  }

  try {
    const summary = await ingestToGraph(transactions, wallets);
    return {
      ok: true,
      enabled: true,
      database: config.graph.database,
      walletsWritten: summary.walletsWritten,
      transactionsWritten: summary.transactionsWritten,
      // `nodesCreated: 0` on a repeat trace is the expected, correct result: it
      // means MERGE recognised everything. Surfaced because it looks alarming
      // until you know that.
      nodesCreated: summary.nodesCreated,
      relationshipsCreated: summary.relationshipsCreated,
      batches: summary.batches,
      durationMs: summary.durationMs,
      ...(summary.rejected.length > 0 ? { rejectedRows: summary.rejected.length } : {}),
      ...(summary.warnings.length > 0 ? { warnings: summary.warnings } : {}),
    };
  } catch (error) {
    logger.error('Graph ingestion failed; returning the trace anyway', {
      message: error?.message,
      neo4jCode: error?.neo4jCode,
    });
    return {
      ok: false,
      enabled: true,
      database: config.graph.database,
      error: error?.message ?? String(error),
      ...(error?.hint ? { hint: error.hint } : {}),
    };
  }
}

/**
 * GET /api/history/:address
 *
 * Query params:
 *   depth  1..MAX_TRACE_DEPTH (default DEFAULT_TRACE_DEPTH)
 *
 * Response (200):
 *   {
 *     ok: true,
 *     query:   { address, depth, ... },
 *     summary: { walletCount, transactionCount, exchangesFound, topExchange, ... },
 *     graph:   { ok, walletsWritten, transactionsWritten, ... },
 *     wallets: [ WalletNode ],
 *     transactions: [ Transfer ],
 *     exchangesFound: [ ... ],
 *     unresolvedLeads: [ ... ],
 *     stats: { ... },
 *     warnings: [ ... ]
 *   }
 */
historyRouter.get(
  '/history/:address',
  validateAddressParam,
  asyncRoute(async (req, res) => {
    const { address, addressDisplay, depth, depthWasClamped } = req.trace;

    // AbortController lets us stop pending RPC backoff waits on timeout or when
    // the client disconnects, instead of letting orphaned work drain the quota.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('trace timeout')), TRACE_TIMEOUT_MS);

    // If the browser navigates away mid-trace, stop working immediately.
    const onClientClose = () => controller.abort(new Error('client disconnected'));
    req.on('close', onClientClose);

    /** @type {Awaited<ReturnType<typeof fetchWalletHistory>>} */
    let result;

    try {
      logger.info('Trace requested', { address: addressDisplay, depth });
      result = await fetchWalletHistory(address, depth, { signal: controller.signal });
    } catch (error) {
      // Turn an abort into a clear 408 rather than an opaque 500.
      if (controller.signal.aborted) {
        const timeoutError = new Error(
          `Trace exceeded ${TRACE_TIMEOUT_MS / 1000}s and was cancelled. ` +
            'Try a smaller ?depth, or lower MAX_FANOUT_PER_ADDRESS.'
        );
        timeoutError.statusCode = 408;
        throw timeoutError;
      }
      throw error;
    } finally {
      // Cleared before ingestion begins, deliberately: the timeout governs the
      // chain fetch only. Otherwise a slow-but-successful trace could have its
      // database write misreported as a request timeout.
      clearTimeout(timeout);
      req.off('close', onClientClose);
    }

    if (depthWasClamped) {
      result.warnings.unshift(
        `Requested depth exceeded the server limit and was reduced to ${config.maxTraceDepth}.`
      );
    }

    // --- Phase 2: persist to Neo4j -----------------------------------------
    const graph = await ingestQuietly(result.wallets, result.transactions);

    if (graph.ok === false && !graph.skipped) {
      result.warnings.push(
        `This trace was NOT saved to Neo4j: ${graph.error} ` +
          'The on-chain result below is complete and unaffected.'
      );
    }
    for (const warning of graph.warnings ?? []) result.warnings.push(warning);

    // Aggregate totals per asset - handy for the Phase 4 sidebar header and
    // far cheaper to compute here than in the browser.
    const totalsByAsset = {};
    for (const transaction of result.transactions) {
      totalsByAsset[transaction.asset] =
        (totalsByAsset[transaction.asset] ?? 0) + transaction.amount;
    }
    for (const [asset, total] of Object.entries(totalsByAsset)) {
      totalsByAsset[asset] = Number(total.toFixed(6));
    }

    // Merge exchanges found on secondary chains so the summary always reflects
    // the full multi-chain picture regardless of MULTI_CHAIN_ENABLED.
    const allExchangesFound = [
      ...result.exchangesFound,
      ...(result.crossChain ?? []).flatMap((cc) => cc.exchangesFound),
    ].sort((a, b) => (a.hop ?? 99) - (b.hop ?? 99) || (b.receivedValue ?? 0) - (a.receivedValue ?? 0));

    res.json({
      ok: true,
      query: {
        address,
        addressDisplay,
        depth: result.depth,
        requestedDepth: depth,
        network: config.network,
        mockMode: config.mockMode,
        multiChainEnabled: config.multiChainEnabled,
      },
      summary: {
        walletCount: result.wallets.length,
        transactionCount: result.transactions.length,
        hopsCompleted: result.stats.hopsCompleted,
        exchangesFound: allExchangesFound.length,
        // The headline answer: shallowest, highest-value exchange reached (any chain).
        topExchange: allExchangesFound[0] ?? null,
        totalsByAsset,
      },
      // What happened when we wrote this trace to the graph.
      graph,
      wallets: result.wallets,
      transactions: result.transactions,
      exchangesFound: result.exchangesFound,
      // Wallets where the trail was cut by a limit rather than by reaching an
      // exchange. These are the leads still worth pulling with a deeper trace.
      unresolvedLeads: result.unresolvedLeads,
      // Cross-chain BFS results keyed by destination chain.
      // [] when MULTI_CHAIN_ENABLED=false.
      crossChain: result.crossChain ?? [],
      stats: result.stats,
      warnings: result.warnings,
    });
  })
);

/**
 * GET /api/config
 *
 * Read-only introspection: traversal limits, tracked assets, the exchange
 * registry, and the graph settings. The Phase 4 UI reads this to render its
 * depth slider bounds, label exchange nodes and explain the risk score, so those
 * values never have to be duplicated in the frontend and drift out of sync.
 */
historyRouter.get('/config', (req, res) => {
  res.json({
    ok: true,
    network: config.network,
    mockMode: config.mockMode,
    limits: {
      defaultTraceDepth: config.defaultTraceDepth,
      maxTraceDepth: config.maxTraceDepth,
      maxFanoutPerAddress: config.maxFanoutPerAddress,
      maxTransfersPerAddress: config.maxTransfersPerAddress,
      maxAddressesPerTrace: config.maxAddressesPerTrace,
      rpcConcurrency: config.rpcConcurrency,
    },
    assets: describeTrackedAssets(),
    graph: {
      enabled: config.graph.enabled,
      database: config.graph.database,
      batchSize: config.graph.batchSize,
      autoIngest: config.graph.enabled,
    },
    riskModel: RISK_MODEL,
    exchanges: {
      count: listKnownExchanges().length,
      // Grouped by operator: the UI wants "Binance", not four hot-wallet labels.
      operators: [...new Set(listKnownExchanges().map((entry) => entry.exchange))].sort(),
      entries: listKnownExchanges().map((entry) => ({
        address: entry.address,
        exchange: entry.exchange,
        label: entry.label,
        walletType: entry.walletType,
      })),
      unverifiedPlaceholders: unverifiedExchanges,
    },
  });
});
