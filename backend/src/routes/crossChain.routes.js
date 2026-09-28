/**
 * routes/crossChain.routes.js
 * ---------------------------------------------------------------------------
 * MODULE 1: Zero-Cost Cross-Chain Correlation API Surface
 * 
 * Provides endpoints for caching pending bridge deposits, triggering
 * temporal-value reconciliation between EVM and non-EVM chains (e.g. BTC, SOL,
 * Thorchain, Polygon), and querying cross-chain bridge links stored in Neo4j.
 */

import { Router } from 'express';
import { asyncRoute } from '../middleware/errorHandler.js';
import {
  cachePendingBridgeDeposit,
  reconcileCrossChainWithdrawal,
  fetchPriceUsd,
} from '../services/crossChainTracker.service.js';
import { runInTransaction } from '../services/neo4j.service.js';
import { isValidAddress, normalizeAddress } from '../lib/addresses.js';

export const crossChainRouter = Router();

/**
 * POST /api/cross-chain/deposit
 * Cache a pending bridge deposit on Chain A.
 *
 * Body: { sourceChain, sourceTxHash, walletAddress, bridgeProtocol, usdValue }
 */
crossChainRouter.post(
  '/deposit',
  asyncRoute(async (req, res) => {
    const { sourceChain, sourceTxHash, walletAddress, bridgeProtocol, usdValue } = req.body;

    if (!sourceChain || !sourceTxHash || !walletAddress || !bridgeProtocol || typeof usdValue !== 'number') {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Required fields: sourceChain, sourceTxHash, walletAddress, bridgeProtocol, usdValue (number)',
        },
      });
    }

    const normalizedAddress = normalizeAddress(walletAddress);
    await cachePendingBridgeDeposit(sourceChain, sourceTxHash, normalizedAddress, bridgeProtocol, usdValue);

    return res.json({
      ok: true,
      message: `Pending bridge deposit cached for ${normalizedAddress} on ${bridgeProtocol}`,
      details: {
        sourceChain,
        sourceTxHash,
        walletAddress: normalizedAddress,
        bridgeProtocol,
        usdValue,
      },
    });
  })
);

/**
 * POST /api/cross-chain/reconcile
 * Reconcile a withdrawal on Chain B against pending deposits.
 *
 * Body: { targetChain, targetTxHash, recipientAddress, bridgeProtocol, targetUsdValue }
 */
crossChainRouter.post(
  '/reconcile',
  asyncRoute(async (req, res) => {
    const { targetChain, targetTxHash, recipientAddress, bridgeProtocol, targetUsdValue } = req.body;

    if (!targetChain || !targetTxHash || !recipientAddress || !bridgeProtocol || typeof targetUsdValue !== 'number') {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Required fields: targetChain, targetTxHash, recipientAddress, bridgeProtocol, targetUsdValue (number)',
        },
      });
    }

    const matched = await reconcileCrossChainWithdrawal(
      targetChain,
      targetTxHash,
      recipientAddress,
      bridgeProtocol,
      targetUsdValue
    );

    return res.json({
      ok: true,
      reconciled: matched,
      message: matched
        ? `Cross-chain withdrawal successfully matched & linked in Neo4j for ${recipientAddress} via ${bridgeProtocol}!`
        : `No matching pending deposit found for ${recipientAddress} on ${bridgeProtocol} within value-time bounds.`,
    });
  })
);

/**
 * GET /api/cross-chain/bridges
 * Query all active BRIDGED_TO links in Neo4j.
 */
crossChainRouter.get(
  '/bridges',
  asyncRoute(async (req, res) => {
    const query = `
      MATCH (a:Wallet)-[r:BRIDGED_TO]->(b:Wallet)
      RETURN a.address          AS sourceAddress,
             b.address          AS targetAddress,
             r.bridge           AS bridgeProtocol,
             r.timeDelta        AS timeDelta,
             r.confidence       AS confidence,
             r.usdIn            AS usdIn,
             r.usdOut           AS usdOut
      LIMIT 100
    `;

    const records = await runInTransaction('READ', async (tx) => {
      const result = await tx.run(query);
      return result.records.map((rec) => ({
        sourceAddress: rec.get('sourceAddress'),
        targetAddress: rec.get('targetAddress'),
        bridgeProtocol: rec.get('bridgeProtocol'),
        timeDelta: rec.get('timeDelta'),
        confidence: rec.get('confidence'),
        usdIn: rec.get('usdIn'),
        usdOut: rec.get('usdOut'),
      }));
    });

    return res.json({
      ok: true,
      count: records.length,
      bridges: records,
    });
  })
);
