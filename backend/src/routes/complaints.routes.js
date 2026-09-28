/**
 * routes/complaints.routes.js
 * ---------------------------------------------------------------------------
 * PHASE 7: MOCK NCRP / SAHYOG Ingestion Webhook
 * 
 * CONTEXT (Hackathon Note):
 * This endpoint is a MOCK of the SAHYOG/NCRP integration surface for SIH 2026.
 * Because real API access to India's national cybercrime platforms is restricted
 * and unavailable for the hackathon, we simulate it here. We accept a plausible
 * JSON schema representing a filed complaint, validate it, and automatically
 * trigger the CryptoTrace pipeline. 
 * 
 * In a production deployment, this would be wired to genuine webhook callbacks
 * from I4C with proper mutual TLS / JWT authentication.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/errorHandler.js';
import { isValidAddress, normalizeAddress } from '../lib/addresses.js';
import { config } from '../config/env.js';
import { fetchWalletHistory } from '../services/walletHistory.service.js';
import { ingestToGraph } from '../services/graph.service.js';
import { findCashOutPaths } from '../services/trace.service.js';
import { findBtcCashOutPaths } from '../services/btcTrace.service.js';
import { ingestBtcAddress } from '../services/btcIngestion.service.js';
import { runBtcClustering } from '../services/btcClustering.service.js';
import { toForceGraph } from '../lib/forceGraph.js';
import { prefetchPrices } from '../lib/valuation.js';
import { enrichTraceGraph } from '../services/riskEngine.service.js';
import { runInTransaction } from '../services/neo4j.service.js';
import { evaluateTrace } from '../services/alertEngine.service.js';
import { progressEmitter, reportProgress, getLastEvent } from '../services/progress.service.js';
import { requireCsrf, requireRole } from '../middleware/auth.js';

export const complaintsRouter = Router();
export const complaintJobs = new Map();
export const inMemoryCrossCaseStore = new Map(); // address -> Set<complaintId>

const VALID_FRAUD_TYPES = [
  "investment_scam", "task_based_fraud", "sextortion", "ransomware",
  "phishing", "darknet_transaction", "other"
];

complaintsRouter.post(
  '/ingest',
  requireCsrf,
  requireRole(['INVESTIGATOR', 'SUPERVISOR']),
  asyncRoute(async (req, res) => {
    const {
      complaintId,
      walletAddress,
      victimWallet,
      fraudType,
      maxHops
    } = req.body;

    // Validate Input
    if (!complaintId || !walletAddress || !fraudType) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Missing required fields: complaintId, walletAddress, fraudType'
        }
      });
    }

    // Basic validation. For BTC we do a looser regex just to pass it through if it looks BTC.
    const isBtc = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(walletAddress);
    if (!isBtc && !isValidAddress(walletAddress)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_ADDRESS',
          message: 'walletAddress must be a valid Ethereum or Bitcoin address'
        }
      });
    }

    const address = isBtc ? walletAddress.trim() : normalizeAddress(walletAddress);
    const victimAddress = victimWallet 
      ? (isBtc ? victimWallet.trim() : normalizeAddress(victimWallet))
      : null;
    
    const caseId = `CASE-${uuidv4().slice(0, 8).toUpperCase()}`;
    const jobId = `job:complaint:${address}:${Date.now()}`;
    
    complaintJobs.set(jobId, { status: 'processing', result: null, error: null });

    // Respond immediately to the frontend
    res.status(202).json({
      ok: true,
      status: 'processing',
      jobId,
      message: 'Complaint ingestion started in the background.',
    });

    // Run the ingestion and trace processing in the background
    (async () => {
      try {
        const traceDepth = typeof maxHops !== 'undefined' ? parseInt(maxHops, 10) : config.defaultTraceDepth;
        console.log(`[ComplaintIngest] Starting background job ${jobId} for address ${address}`);

        let allTransactions = [];
        let allWallets = [];
        let wroteAnything = false;
        let ingestionSummary = null;
        
        // 1. Optional Victim Wallet Ingestion (1 hop to connect to suspect)
        if (victimAddress) {
          reportProgress(jobId, 'fetching_history', `Pulling victim history...`);
          if (isBtc) {
            await ingestBtcAddress(victimAddress, 1).catch(() => null);
          } else {
            const vicHistory = await fetchWalletHistory(victimAddress, 1).catch(() => null);
            if (vicHistory && config.graph.enabled) {
              await ingestToGraph(vicHistory.transactions, vicHistory.wallets).catch(() => null);
            }
          }
        }

        if (isBtc) {
          reportProgress(jobId, 'fetching_history', `Pulling on-chain transfers (BTC Mempool API)`);
          const btcResult = await ingestBtcAddress(address, traceDepth);
          if (btcResult.ok && btcResult.ingested > 0) {
            wroteAnything = true;
            ingestionSummary = { walletsWritten: 0, transactionsWritten: btcResult.ingested };
            reportProgress(jobId, 'clustering', 'Running UTXO common-input-ownership clustering…');
            await runBtcClustering();
          } else if (!btcResult.ok) {
            throw new Error(btcResult.message || btcResult.error || "BTC Ingestion failed");
          }
          // Note: BTC ingestion doesn't return full list of downstream wallets to `allWallets`,
          // so crossCase memory fallback will only track the start address if graph is disabled.
        } else {
          const history = await fetchWalletHistory(address, traceDepth, {
            onProgress: ({ hop, addresses, completed }) => {
              const detail = completed 
                ? `Fetched ${completed}/${addresses} wallets in Hop ${hop + 1}`
                : `Tracing ${addresses} wallets`;
              reportProgress(jobId, 'fetching_history', `Pulling on-chain transfers (Hop ${hop + 1}/${traceDepth})`, detail);
            }
          });
          allTransactions = [...history.transactions];
          allWallets = [...history.wallets];
          
          if (Array.isArray(history.crossChain)) {
            for (const cc of history.crossChain) {
              allTransactions.push(...(cc.transactions || []));
              allWallets.push(...(cc.wallets || []));
            }
          }
          
          if (allTransactions.length > 0 && config.graph.enabled) {
            reportProgress(jobId, 'ingesting', 'Writing wallets and transfers into graph database…', `${allTransactions.length} transfers found`);
            ingestionSummary = await ingestToGraph(allTransactions, allWallets, {
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
            }).catch(() => null);
            wroteAnything = Boolean(ingestionSummary?.batchesSucceeded > 0 || ingestionSummary?.ok);
          }
        }

        // Always register in inMemoryCrossCaseStore for fallback/mock mode
        const downstreamAddresses = allWallets.map(w => w.address.toLowerCase()).filter(a => a !== address.toLowerCase());
        for (const dw of downstreamAddresses) {
          if (!inMemoryCrossCaseStore.has(dw)) {
            inMemoryCrossCaseStore.set(dw, new Set());
          }
          inMemoryCrossCaseStore.get(dw).add(complaintId);
        }

        console.log('[ComplaintIngest] Step 3: Marking fraud type in Neo4j and memory');
        if (config.graph.enabled) {
          try {
            await runInTransaction('WRITE', async (tx) => {
              await tx.run(
                `MATCH (w:Wallet {address: $address}) 
                 MERGE (c:Case {id: $caseId})
                 MERGE (i:Investigator {id: $investigatorId})
                 MERGE (c)-[:ASSIGNED_TO]->(i)
                 SET c.suspectWallet = $address, c.victimWallet = coalesce(c.victimWallet, $address)
                 SET w.fraudType = $fraudType
                 SET w.complaintIds = CASE WHEN $complaintId IN coalesce(w.complaintIds, []) THEN coalesce(w.complaintIds, []) ELSE coalesce(w.complaintIds, []) + [$complaintId] END
                 SET w.caseIds = CASE WHEN $caseId IN coalesce(w.caseIds, []) THEN coalesce(w.caseIds, []) ELSE coalesce(w.caseIds, []) + [$caseId] END
                 RETURN w`,
                { address, fraudType, complaintId, caseId, investigatorId: req.investigator.id }
              );
              
              if (downstreamAddresses.length > 0) {
                await tx.run(
                  `MATCH (intermediary:Wallet)
                   WHERE intermediary.address IN $addresses
                     AND coalesce(intermediary.isExchange, false) = false
                   SET intermediary.crossCaseIds = CASE WHEN $complaintId IN coalesce(intermediary.crossCaseIds, []) THEN coalesce(intermediary.crossCaseIds, []) ELSE coalesce(intermediary.crossCaseIds, []) + [$complaintId] END
                   SET intermediary.crossCaseAlert = CASE WHEN size(intermediary.crossCaseIds) > 1 THEN true ELSE false END`,
                  { addresses: downstreamAddresses, complaintId }
                );
              }
            });
          } catch (graphErr) {
            console.log('[ComplaintIngest] Neo4j update skipped (offline/fallback mode):', graphErr.message);
          }
        }

        console.log('[ComplaintIngest] Step 4: Running shortestPath trace');
        reportProgress(jobId, 'pathfinding', 'Searching for the shortest route to a known exchange…');
        let traceResult = isBtc 
          ? await findBtcCashOutPaths(address, { maxHops: traceDepth })
          : await findCashOutPaths(address, { maxHops: traceDepth });
        
        // Emulate the ingestion object expected by the frontend's EmptyState.jsx / TraceLoadingPanel.jsx
        traceResult.ingestion = {
          attempted: true,
          ok: true,
          wroteAnything,
          depth: traceDepth,
          walletsWritten: ingestionSummary?.walletsWritten ?? allWallets.length,
          transactionsWritten: ingestionSummary?.transactionsWritten ?? allTransactions.length,
        };
        
        console.log('[ComplaintIngest] Step 4a: traceResult found:', traceResult.found);
        if (traceResult.found) {
          console.log('[ComplaintIngest] Step 4b: enriching graph');
          reportProgress(jobId, 'risk_scoring', 'Scoring wallet risk across velocity, fan-out, and mixer patterns…');
          await prefetchPrices(traceResult);
          let finalForceGraph = await enrichTraceGraph(toForceGraph(traceResult));
          
          // Apply graph pruning if nodes exceed 500
          if (finalForceGraph && finalForceGraph.nodes.length > 500) {
            console.log(`[ComplaintIngest] Pruning massive graph from ${finalForceGraph.nodes.length} nodes`);
            reportProgress(jobId, 'partial', 'Graph is massive — taking longer than expected. Pruning for performance.', `Pruning ${finalForceGraph.nodes.length} nodes`);
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
            console.log(`[ComplaintIngest] Graph pruned down to ${finalForceGraph.nodes.length} essential nodes`);
          }
          
          traceResult.forceGraph = finalForceGraph;
          console.log('[ComplaintIngest] Step 4c: evaluating trace');
          reportProgress(jobId, 'ai_brief', 'Evaluating cross-case alerts…');
          evaluateTrace(traceResult, caseId);
        }

        console.log(`[ComplaintIngest] Completed job ${jobId}`);
        reportProgress(jobId, 'done', 'Trace complete.');
        complaintJobs.set(jobId, {
          status: 'completed',
          result: {
            ok: true,
            caseId,
            complaintId,
            fraudType,
            traceResult
          }
        });
      } catch (err) {
        console.error('[ComplaintIngest] Complaint ingestion failed:', err);
        reportProgress(jobId, 'error', `Complaint ingestion failed: ${err.message}`);
        complaintJobs.set(jobId, {
          status: 'failed',
          error: err.message || 'Complaint ingestion failed'
        });
      }
    })();
  })
);

complaintsRouter.get(
  '/status/:jobId',
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { jobId } = req.params;
    const job = complaintJobs.get(jobId);

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    if (job.status === 'processing') {
      return res.json({ ok: true, status: 'processing' });
    }

    if (job.status === 'failed') {
      return res.json({ ok: false, status: 'failed', error: job.error });
    }

    return res.json({
      status: 'completed',
      ...job.result
    });
  })
);

/**
 * GET /api/complaints/stream/:jobId
 * Server-Sent Events (SSE) endpoint for real-time trace progress.
 */
complaintsRouter.get(['/stream/:jobId', '/complaints/stream/:jobId'], (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*' // If needed depending on CORS setup
  });

  // Send an initial heartbeat
  res.write(': heartbeat\n\n');

  const job = complaintJobs.get(jobId);
  if (job) {
    if (job.status === 'completed') {
      res.write(`data: ${JSON.stringify({ stage: 'done', message: 'Trace complete.' })}\n\n`);
      return res.end();
    }
    if (job.status === 'failed') {
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
