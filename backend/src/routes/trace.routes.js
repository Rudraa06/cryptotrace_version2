/**
 * routes/trace.routes.js
 * ---------------------------------------------------------------------------
 * PHASE 3 HTTP surface - the analytical answer.
 *
 *   GET /api/trace/:address    shortestPath from the reported wallet to a CEX
 *
 * This is the endpoint the Phase 4 dashboard calls. It differs from
 * `/api/history/:address` in what it asks and where it looks: `/api/history`
 * pulls from the chain and writes to Neo4j (ingestion and diagnostics), while
 * this route reads the graph and answers "where did the money cash out".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE INGESTS ON A MISS
 * ---------------------------------------------------------------------------
 * A graph query against a wallet nobody has ingested returns nothing, and
 * "nothing" is exactly what a clean wallet returns too. An investigator pasting
 * a victim-reported address into the dashboard should not have to know that two
 * endpoints exist and that one must be called first.
 *
 * So on `WALLET_NOT_IN_GRAPH` this route runs the Phase 1 on-chain trace, writes
 * it to Neo4j, and re-queries once. Exactly once - if the wallet is still absent
 * after a successful ingest, that is a real answer (the address has no transfers
 * in the tracked asset set) and looping again would only burn RPC quota.
 *
 * `?ingest=false` turns the fallback off, which is what the smoke tests use to
 * assert the three distinct empty cases without needing a chain.
 *
 * ---------------------------------------------------------------------------
 * WHY AN EMPTY RESULT IS 200 AND NOT 404
 * ---------------------------------------------------------------------------
 * "I searched and found no route" is a successful query with a negative finding,
 * not a missing resource. A 404 would tell the dashboard's fetch layer to render
 * an error state, when the correct render is the finding itself plus the hint
 * that explains which of the three causes it was. The body carries `found: false`
 * and a `reason`, and the caller decides how to present it.
 */

import { Router } from 'express';

import { config } from '../config/env.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { validateAddressParam } from '../middleware/validateAddress.js';
import {
  findCashOutPaths,
  findDirectPath,
  DEFAULT_MAX_HOPS,
  MAX_HOPS_CEILING,
  MAX_CONTEXT_EDGES,
} from '../services/trace.service.js';
import { toForceGraph } from '../lib/forceGraph.js';
import { prefetchPrices } from '../lib/valuation.js';
import { fetchWalletHistory } from '../services/walletHistory.service.js';
import { ingestToGraph } from '../services/graph.service.js';
import { findBtcCashOutPaths } from '../services/btcTrace.service.js';
import { ingestBtcAddress } from '../services/btcIngestion.service.js';
import { runBtcClustering } from '../services/btcClustering.service.js';
import { verifyGraphConnectivity } from '../services/neo4j.service.js';
import { logger } from '../lib/logger.js';
import { enrichTraceGraph } from '../services/riskEngine.service.js';
import { generateCaseBrief } from '../services/aiNarrative.service.js';
import { evaluateTrace } from '../services/alertEngine.service.js';
import { Redis } from 'ioredis';
import { progressEmitter, reportProgress, getLastEvent } from '../services/progress.service.js';
import { logAuditAction } from '../services/audit.service.js';
import { requireRole, requireCsrf } from '../middleware/auth.js';

import { Queue, Worker } from 'bullmq';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    if (times > 3) return null;
    return Math.min(times * 50, 2000);
  }
});

redis.on('error', (err) => {
  if (err.code !== 'ECONNREFUSED') {
    logger.error('Redis error:', err);
  }
});
const TRACE_CACHE_TTL = 900; // 15 minutes

export const traceRouter = Router();
export const traceJobs = new Map();
export const traceQueue = new Queue('traceQueue', { connection: redis });

const traceWorker = new Worker('traceQueue', async (job) => {
  const { address, addressDisplay, depth, depthWasClamped, options, allowIngest, includeForceGraph, cacheKey, jobId } = job.data;
  
  const isBtc = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(address);
  reportProgress(jobId, 'pathfinding', 'Searching for the shortest route to a known exchange…');
  let result = isBtc ? await findBtcCashOutPaths(address, options) : await findCashOutPaths(address, options);
  let ingestion = null;

  if (!result.found && allowIngest) {
    logger.info('No exchange reached in current graph; starting background on-chain trace', {
      address: addressDisplay,
      depth,
    });
    ingestion = await ingestFromChain(address, depth, jobId);
    if (ingestion.ok && ingestion.wroteAnything) {
      reportProgress(jobId, 'pathfinding', 'Searching graph again after successful ingestion…');
      result = isBtc ? await findBtcCashOutPaths(address, options) : await findCashOutPaths(address, options);
    }
  }

  const finalResponse = await assembleTraceResponse(
    result, options, ingestion, depthWasClamped, depth, address, addressDisplay, includeForceGraph, jobId
  );

  reportProgress(jobId, 'done', 'Trace complete.');
  traceJobs.set(jobId, { status: 'done', response: finalResponse });
  await redis.setex(jobId, 600, JSON.stringify({ status: 'done', response: finalResponse })).catch(() => null);
  await redis.setex(cacheKey, TRACE_CACHE_TTL, JSON.stringify(finalResponse)).catch(() => null);
  return finalResponse;
}, { connection: redis });

traceWorker.on('failed', async (job, err) => {
  const { address, jobId } = job.data;
  logger.error('Background trace processing failed', { address, error: err.message });
  traceJobs.set(jobId, { status: 'error', error: err.message });
  await redis.setex(jobId, 600, JSON.stringify({ status: 'error', error: err.message })).catch(() => null);
});

/**
 * Ceiling for the on-chain fallback fetch. Lower than `/api/history`'s 90s: the
 * user is waiting on a graph query they expected to be instant, and a fallback
 * that silently takes a minute and a half feels broken even when it works.
 */
const FALLBACK_TIMEOUT_MS = 60_000;

/**
 * Parse a boolean query parameter.
 *
 * Absent means the default. Present but unparseable is a 400 rather than a
 * silent fallback, for the same reason `?depth` is: demoing with `?ingest=flase`
 * and believing ingestion is off is worse than being told the parameter is bad.
 *
 * @param {unknown} raw
 * @param {boolean} fallback
 * @param {string} name
 */
function boolParam(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;

  const error = new Error(
    `Invalid "${name}" query parameter: "${raw}". Expected true or false.`
  );
  error.statusCode = 400;
  throw error;
}

/**
 * Parse `?maxHops`.
 *
 * The service's `assertHopBound` is the real gate - it has to be, because it is
 * the value interpolated into Cypher. This is a friendlier pre-check that names
 * the parameter, so the caller gets "maxHops must be..." rather than a message
 * about an internal argument.
 *
 * @param {unknown} raw
 */
function parseMaxHops(raw) {
  if (raw === undefined || raw === '') return DEFAULT_MAX_HOPS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HOPS_CEILING) {
    const error = new Error(
      `Invalid "maxHops" query parameter: "${raw}". Expected an integer between 1 and ${MAX_HOPS_CEILING}.`
    );
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

/**
 * Run the Phase 1 on-chain trace and write it to Neo4j.
 *
 * Returns a report rather than throwing: a failed fallback still leaves us with
 * a legitimate answer to return (the original "not in graph" result), and that
 * answer plus an explanation of why the fallback did not help is more useful
 * than a 500.
 */
async function ingestFromChain(address, depth, jobId) {
  // Dynamic timeout based on requested depth to prevent exponential fan-out crashes
  const timeoutMs = Math.floor(15000 + Math.pow(depth, 1.5) * 5000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const isBtc = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(address);

  if (isBtc) {
    try {
      reportProgress(jobId, 'fetching_history', `Pulling on-chain transfers (BTC Mempool API)`);
      const btcResult = await ingestBtcAddress(address, depth);
      clearTimeout(timer);
      if (!btcResult.ok) {
        return {
          attempted: true,
          ok: false,
          wroteAnything: false,
          depth,
          error: btcResult.message ?? btcResult.error,
        };
      }
      // Run common-input-ownership clustering to materialize SENT_TO edges
      // that findBtcCashOutPaths needs for shortestPath queries.
      if (btcResult.ingested > 0) {
        reportProgress(jobId, 'clustering', 'Running UTXO common-input-ownership clustering…');
        const clusterResult = await runBtcClustering();
        if (!clusterResult.ok) {
          logger.warn('BTC clustering failed after ingestion', { error: clusterResult.message });
        }
      }
      return {
        attempted: true,
        ok: true,
        wroteAnything: btcResult.ingested > 0,
        depth,
        transactionsWritten: btcResult.ingested,
      };
    } catch (error) {
      clearTimeout(timer);
      logger.warn('BTC on-chain fallback for /api/trace failed', {
        address,
        message: error?.message,
      });
      return {
        attempted: true,
        ok: false,
        wroteAnything: false,
        depth,
        error: error?.message ?? String(error),
      };
    }
  }

  try {
    const history = await fetchWalletHistory(address, depth, { 
      signal: controller.signal,
      onProgress: ({ hop, addresses, completed }) => {
        const detail = completed 
          ? `Fetched ${completed}/${addresses} wallets in Hop ${hop + 1}`
          : `Tracing ${addresses} wallets`;
        reportProgress(jobId, 'fetching_history', `Pulling on-chain transfers (Hop ${hop + 1}/${depth})`, detail);
      }
    });
    // Cleared before ingestion so a slow-but-successful chain fetch is not
    // misreported as a timeout while the database write is still running.
    clearTimeout(timer);

    if (history.transactions.length === 0) {
      return {
        attempted: true,
        ok: true,
        wroteAnything: false,
        depth,
        reason:
          'The on-chain trace found no transfers in the tracked asset set for this address, ' +
          'so there was nothing to ingest.',
      };
    }

    const allTransactions = [...history.transactions];
    const allWallets = [...history.wallets];

    if (Array.isArray(history.crossChain)) {
      for (const cc of history.crossChain) {
        allTransactions.push(...(cc.transactions || []));
        allWallets.push(...(cc.wallets || []));
      }
    }

    reportProgress(jobId, 'ingesting', 'Writing wallets and transfers into graph database…', `${allTransactions.length} transfers found`);
    const summary = await ingestToGraph(allTransactions, allWallets, {
      onProgress: ({ phase, batch, totalBatches, count }) => {
        reportProgress(
          jobId,
          'ingesting',
          phase === 'wallets' 
            ? `Ingesting wallet batch ${batch}/${totalBatches} into Neo4j`
            : `Ingesting transaction batch ${batch}/${totalBatches} into Neo4j`,
          `Processing ${count} ${phase} (Batch ${batch}/${totalBatches})`
        );
      }
    });
    return {
      attempted: true,
      ok: summary.ok,
      wroteAnything: summary.batchesSucceeded > 0,
      depth,
      walletsWritten: summary.walletsWritten,
      transactionsWritten: summary.transactionsWritten,
      batchesAttempted: summary.batchesAttempted,
      batchesSucceeded: summary.batchesSucceeded,
      nodesCreated: summary.nodesCreated,
      relationshipsCreated: summary.relationshipsCreated,
      durationMs: summary.durationMs,
    };
  } catch (error) {
    clearTimeout(timer);
    logger.warn('On-chain fallback for /api/trace failed', {
      address,
      message: error?.message,
    });
    return {
      attempted: true,
      ok: false,
      wroteAnything: false,
      depth,
      error: error?.message ?? String(error),
      ...(error?.hint ? { hint: error.hint } : {}),
    };
  }
}

/**
 * GET /api/trace/:address
 *
 * Query params:
 *   maxHops   1..25       (default 15) length bound on shortestPath
 *   depth     1..MAX      (default config) depth used only if the fallback runs
 *   ingest    true|false  (default true) fetch from chain when not in the graph
 *   context   true|false  (default true) include one hop of surrounding fan-out
 *   graph     true|false  (default true) include the {nodes, links} payload
 *
 * Response (200), whether or not a route was found:
 *   {
 *     ok: true,
 *     found: boolean,
 *     query: { address, addressDisplay, maxHops, includeContext },
 *     topExchange, shortestHops, paths[], contextEdges[],
 *     forceGraph: { nodes, links, legend, meta },
 *     ingestion?: { ... },     // only when the fallback ran
 *     stats, warnings[]
 *   }
 */
traceRouter.get(
  '/trace/:address',
  requireRole(['INVESTIGATOR', 'SUPERVISOR']),
  validateAddressParam,
  asyncRoute(async (req, res) => {
    const { address, addressDisplay, depth, depthWasClamped } = req.trace;

    const maxHops = parseMaxHops(req.query.maxHops);
    const allowIngest = boolParam(req.query.ingest, true, 'ingest');
    const includeContext = boolParam(req.query.context, true, 'context');
    const includeForceGraph = boolParam(req.query.graph, true, 'graph');

    await logAuditAction('TRACE_QUERY', req.investigator, { address, maxHops, allowIngest, includeContext });

    // --- Guards, in the order a failure actually occurs -----------------------
    // Same shape as graph.routes.js: an explicitly disabled graph and an
    // unreachable one are different problems with different fixes, and both are
    // 503 with a named code rather than a stack trace.

    if (!config.graph.enabled) {
      res.status(503).json({
        ok: false,
        error: {
          code: 'GRAPH_DISABLED',
          message:
            'Path tracing reads from Neo4j, and the graph subsystem is turned off.',
          hint: 'Set GRAPH_ENABLED=true in backend/.env and restart the server.',
        },
      });
      return;
    }

    const connectivity = await verifyGraphConnectivity();
    if (!connectivity.ok) {
      res.status(503).json({
        ok: false,
        error: {
          code: 'GRAPH_UNAVAILABLE',
          message: connectivity.message ?? 'Neo4j is not reachable.',
          ...(connectivity.hint ? { hint: connectivity.hint } : {}),
          uri: connectivity.uri,
        },
      });
      return;
    }

    const cacheKey = `trace:result:${address}:${maxHops}:${includeContext}:${includeForceGraph}`;
    const cachedData = await redis.get(cacheKey).catch(() => null);

    if (cachedData) {
      try {
        const parsedData = JSON.parse(cachedData);
        parsedData.cached = true;
        logger.info('Served trace result from Redis cache', { address: addressDisplay });
        return res.json(parsedData);
      } catch (err) {
        logger.warn('Failed to parse cached trace result, falling back to fresh query', { address: addressDisplay, error: err.message });
      }
    }

    const options = { maxHops, includeContext, contextLimit: MAX_CONTEXT_EDGES };
    const jobId = `job:trace:${address}:${Date.now()}`;
    
    traceJobs.set(jobId, { status: 'processing', address });
    await redis.setex(jobId, 600, JSON.stringify({ status: 'processing', address })).catch(() => null);

    // Return 202 Accepted immediately so HTTP request never times out
    res.status(202).json({ ok: true, status: 'processing', jobId });

    // Execute trace query and potential on-chain fallback in background via BullMQ
    await traceQueue.add('trace', {
      address, addressDisplay, depth, depthWasClamped, options, allowIngest, includeForceGraph, cacheKey, jobId
    }, { removeOnComplete: true, removeOnFail: true });
  })
);

async function assembleTraceResponse(result, options, ingestion, depthWasClamped, depth, address, addressDisplay, includeForceGraph, jobId) {
  const warnings = [...(result.warnings ?? [])];

  if (depthWasClamped) {
    warnings.push(`The requested depth was above the configured maximum and was clamped to ${depth}.`);
  }

  if (ingestion?.attempted && !ingestion.ok) {
    warnings.push('This wallet was not in the graph, and the on-chain fallback that would have added it ' +
      `failed: ${ingestion.error} The result below reflects only what was already ingested.`);
  }

  if (ingestion?.ok && !ingestion.wroteAnything) {
    warnings.push('This wallet was not in the graph, and an on-chain trace found no transfers in the ' +
      'tracked asset set (native coin and stablecoins). An address that has only ever ' +
      'moved other tokens will look empty here.');
  }

  let finalForceGraph = null;
  if (includeForceGraph) {
    reportProgress(jobId, 'risk_scoring', 'Scoring wallet risk across velocity, fan-out, and mixer patterns…');
    await prefetchPrices(result);
    finalForceGraph = await enrichTraceGraph(toForceGraph(result));
  }

  if (finalForceGraph && finalForceGraph.nodes.length > 500) {
    reportProgress(jobId, 'partial', 'Graph is massive — taking longer than expected. Pruning for performance.', `Pruning ${finalForceGraph.nodes.length} nodes`);
    warnings.push(`Graph contained ${finalForceGraph.nodes.length} nodes. Pruned non-essential context nodes to improve performance.`);
    const essentialNodes = new Set();
    finalForceGraph.nodes = finalForceGraph.nodes.filter(n => {
      if (n.onPath || n.isExchange) {
        essentialNodes.add(n.id);
        return true;
      }
      return false;
    });
    finalForceGraph.links = finalForceGraph.links.filter(l => 
      essentialNodes.has(typeof l.source === 'object' ? l.source.id : l.source) && 
      essentialNodes.has(typeof l.target === 'object' ? l.target.id : l.target)
    );
  }

  let aiNarrative = null;
  if (result.found && finalForceGraph) {
    reportProgress(jobId, 'ai_brief', 'Asking the AI copilot to draft a case summary…');
    const tracePayload = {
      query: { address, addressDisplay },
      paths: result.paths,
      shortestHops: result.shortestHops,
      topExchange: result.topExchange,
      forceGraph: finalForceGraph,
    };

    const narrativeResult = await generateCaseBrief(tracePayload);
    aiNarrative = narrativeResult;

    if (!narrativeResult.ok && !narrativeResult.skipped) {
      warnings.push('AI case brief generation failed; the graph result is complete and unaffected.');
    }
  }

  return {
    ok: true,
    ...result,
    ...(finalForceGraph ? { forceGraph: finalForceGraph } : {}),
    ...(aiNarrative ? { aiNarrative } : {}),
    ...(ingestion ? { ingestion } : {}),
    warnings,
  };
}

traceRouter.get(['/status/:jobId', '/trace/status/:jobId'], asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const { jobId } = req.params;
  let parsed = null;

  const data = await redis.get(jobId).catch(() => null);
  if (data) {
    try { parsed = JSON.parse(data); } catch (_) {}
  }

  if (!parsed) {
    parsed = traceJobs.get(jobId);
  }

  if (!parsed) return res.status(404).json({ ok: false, error: 'Job not found or expired' });

  if (parsed.status === 'processing') return res.status(202).json(parsed);
  if (parsed.status === 'error') return res.status(500).json(parsed);
  return res.json(parsed.response || parsed);
}));

/**
 * GET /api/trace/stream/:jobId
 * Server-Sent Events (SSE) endpoint for real-time trace progress.
 */
traceRouter.get(['/stream/:jobId', '/trace/stream/:jobId'], (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*' // If needed depending on CORS setup
  });

  // Send an initial heartbeat
  res.write(': heartbeat\n\n');

  // Check if the job is already finished to prevent the client from hanging forever
  // if they connect after the background job has completed.
  const job = traceJobs.get(jobId);
  if (job) {
    if (job.status === 'done') {
      res.write(`data: ${JSON.stringify({ stage: 'done', message: 'Trace complete.' })}\n\n`);
      return res.end();
    }
    if (job.status === 'error') {
      res.write(`data: ${JSON.stringify({ stage: 'error', message: job.error })}\n\n`);
      return res.end();
    }
  }

  // Emit the last known state so the client doesn't miss the current stage if they connected late
  const lastEvent = getLastEvent(jobId);
  if (lastEvent) {
    res.write(`data: ${JSON.stringify(lastEvent)}\n\n`);
  }

  const onProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    
    // Close the stream if we hit a terminal state
    if (data.stage === 'done' || data.stage === 'error') {
      progressEmitter.removeListener(`progress:${jobId}`, onProgress);
      res.end();
    }
  };

  progressEmitter.on(`progress:${jobId}`, onProgress);

  // Clean up if the client disconnects early
  req.on('close', () => {
    progressEmitter.removeListener(`progress:${jobId}`, onProgress);
  });
});

/**
 * POST /api/trace/correlate
 * PHASE 2B: Suspect Wallet Cross-Case Lookup
 */
traceRouter.post(
  '/trace/correlate',
  requireCsrf,
  requireRole(['SUPERVISOR']),
  asyncRoute(async (req, res) => {
    const { victimWallet, suspectWallet, maxHops } = req.body;
    
    if (!victimWallet || !suspectWallet) {
      return res.status(400).json({ ok: false, error: { message: 'Missing victimWallet or suspectWallet' } });
    }

    await logAuditAction('CORRELATE_LOOKUP', req.investigator, { victimWallet, suspectWallet });

    // 1. Direct Link Check
    const directLink = await findDirectPath(victimWallet, suspectWallet, maxHops || DEFAULT_MAX_HOPS);

    // 2. Cross-Case Footprint Query
    const footprintQuery = `
      MATCH (suspect:Wallet) WHERE toLower(suspect.address) = toLower($suspectWallet)
      RETURN suspect.caseIds AS caseIds, suspect.complaintIds AS complaintIds
    `;
    
    let footprint = { cases: 0, roles: [] };
    
    try {
      const { runInTransaction } = await import('../services/neo4j.service.js');
      await runInTransaction('READ', async (tx) => {
        const result = await tx.run(footprintQuery, { suspectWallet });
        if (result.records.length > 0) {
          const caseIds = result.records[0].get('caseIds') || [];
          footprint.cases = caseIds.length;
          // Dummy role classification for now until graph footprint classification is fully built
          footprint.roles = caseIds.map(cId => ({
            caseId: cId,
            role: 'intermediary'
          }));
        }
      });
    } catch (e) {
      logger.warn('Failed footprint query', { error: e.message });
    }

    res.json({
      ok: true,
      directLink,
      footprint
    });
  })
);
