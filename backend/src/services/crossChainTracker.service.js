/**
 * services/crossChainTracker.service.js
 * ---------------------------------------------------------------------------
 * MODULE 1: Zero-Cost Cross-Chain Correlation Engine
 * 
 * Tracks bridge deposits on EVM chains, caches them in a local Redis instance
 * (avoiding paid messaging queues), and reconciles them against non-EVM withdrawals
 * (e.g. Solana or Bitcoin) using public free-tier REST APIs.
 */

import { Redis } from 'ioredis';
import { runInTransaction } from './neo4j.service.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/env.js';
import { createLimiter } from '../lib/concurrency.js';
import { normalizeAddress, toChecksum } from '../lib/addresses.js';

// Fetch is natively available in Node > 18
const crossChainLimiter = createLimiter(config.rpcConcurrency);

// Use local Redis Docker container by default
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    if (times > 3) return null;
    return Math.min(times * 50, 2000);
  }
});
redis.on('error', (err) => {
  if (err.code !== 'ECONNREFUSED') {
    logger.error('Redis error (CrossChain):', err);
  }
});

// 3600 seconds = 1 hour maximum bridge reconciliation window
const BRIDGE_CACHE_TTL = 3600; 

/**
 * 1. Cache a pending bridge deposit detected on Chain A.
 * 
 * @param {string} sourceChain - e.g., 'ETH'
 * @param {string} sourceTxHash - The transaction hash of the deposit
 * @param {string} walletAddress - The depositor
 * @param {string} bridgeProtocol - e.g., 'Thorchain'
 * @param {number} usdValue - The calculated USD value at time of deposit
 */
export async function cachePendingBridgeDeposit(sourceChain, sourceTxHash, walletAddress, bridgeProtocol, usdValue) {
  const normAddress = normalizeAddress(walletAddress);
  const key = `bridge:pending:${bridgeProtocol}:${sourceTxHash}`;
  const payload = {
    sourceChain,
    walletAddress: normAddress,
    usdValue,
    timestamp: Math.floor(Date.now() / 1000)
  };

  try {
    await redis.setex(key, BRIDGE_CACHE_TTL, JSON.stringify(payload));
  } catch (error) {
    logger.debug(`[CrossChain] Redis cache fallback used: ${error.message} - saving to Neo4j`);
    const query = `
      MERGE (d:PendingBridgeDeposit { sourceTxHash: $sourceTxHash, bridgeProtocol: $bridgeProtocol })
      SET d.sourceChain = $sourceChain,
          d.walletAddress = $normAddress,
          d.usdValue = $usdValue,
          d.timestamp = $timestamp
    `;
    await runInTransaction('WRITE', async (tx) => {
      await tx.run(query, { sourceTxHash, bridgeProtocol, sourceChain, normAddress, usdValue, timestamp: payload.timestamp });
    });
  }
  logger.info(`[CrossChain] Cached pending deposit: ${normAddress} on ${bridgeProtocol} for $${usdValue}`);
}

/**
 * 2. Reconcile a detected withdrawal on Chain B against the pending cache.
 * Uses the temporal-value heuristic.
 * 
 * @param {string} targetChain - e.g., 'BTC' or 'SOL'
 * @param {string} targetTxHash - The withdrawal transaction hash
 * @param {string} recipientAddress - The receiving wallet on Chain B
 * @param {string} bridgeProtocol - The bridge used
 * @param {number} targetUsdValue - Calculated USD value of the withdrawal
 */
export async function reconcileCrossChainWithdrawal(targetChain, targetTxHash, recipientAddress, bridgeProtocol, targetUsdValue) {
  try {
    const normRecipient = normalizeAddress(recipientAddress);
    const now = Math.floor(Date.now() / 1000);
    const entries = [];

    // 1. Try Redis first
    try {
      const keys = await redis.keys(`bridge:pending:${bridgeProtocol}:*`);
      for (const key of keys) {
        const dataStr = await redis.get(key);
        if (dataStr) {
          entries.push({ key, deposit: JSON.parse(dataStr) });
        }
      }
    } catch (_) {}

    // 2. Fall back to Neo4j store
    if (entries.length === 0) {
      const query = `
        MATCH (d:PendingBridgeDeposit { bridgeProtocol: $bridgeProtocol })
        RETURN d
      `;
      await runInTransaction('READ', async (tx) => {
        const result = await tx.run(query, { bridgeProtocol });
        for (const record of result.records) {
          const d = record.get('d').properties;
          const deposit = {
            sourceChain: d.sourceChain,
            walletAddress: d.walletAddress,
            usdValue: typeof d.usdValue === 'number' ? d.usdValue : d.usdValue.toNumber(),
            timestamp: typeof d.timestamp === 'number' ? d.timestamp : d.timestamp.toNumber(),
            sourceTxHash: d.sourceTxHash
          };
          entries.push({ key: `neo4j:${d.sourceTxHash}`, deposit });
        }
      });
    }

    for (const { key, deposit } of entries) {
      // Temporal Heuristic: Must be >= 0 and <= 3600s
      const timeDelta = now - deposit.timestamp;
      if (timeDelta < 0 || timeDelta > BRIDGE_CACHE_TTL) continue;

      // Value Heuristic: 0.98 <= (V_B / V_A) <= 1.00
      // Accounting for up to 2% bridge fee slippage
      const valueRatio = targetUsdValue / deposit.usdValue;
      if (valueRatio >= 0.98 && valueRatio <= 1.00) {
        logger.info(`[CrossChain] Match Found! ${deposit.walletAddress} bridged to ${normRecipient}`);
        
        // Match found! Write to Neo4j
        const confidence = 1 - Math.abs(1 - valueRatio);
        await linkBridgedWallets(deposit.walletAddress, normRecipient, bridgeProtocol, timeDelta, confidence, deposit.usdValue, targetUsdValue);
        
        // Remove from caches so it doesn't double-match
        if (key.startsWith('neo4j:')) {
          await runInTransaction('WRITE', async (tx) => {
            await tx.run(`MATCH (d:PendingBridgeDeposit { sourceTxHash: $sourceTxHash }) DELETE d`, { sourceTxHash: deposit.sourceTxHash });
          });
        } else {
          await redis.del(key).catch(() => null);
        }
        return true;
      }
    }
    return false;
  } catch (error) {
    logger.error(`[CrossChain] Reconciliation error: ${error.message}`);
    return false;
  }
}

/**
 * 3. Write the multi-chain [BRIDGED_TO] relationship to Neo4j
 */
async function linkBridgedWallets(sourceWallet, targetWallet, bridge, timeDelta, confidence, usdIn, usdOut) {
  const normSource = normalizeAddress(sourceWallet);
  const normTarget = normalizeAddress(targetWallet);

  const query = `
    MERGE (a:Wallet {address: $normSource})
    ON CREATE SET a.addressDisplay = $displaySource
    MERGE (b:Wallet {address: $normTarget})
    ON CREATE SET b.addressDisplay = $displayTarget
    MERGE (a)-[r:BRIDGED_TO {
      bridge: $bridge,
      timeDelta: $timeDelta
    }]->(b)
    SET r.confidence = $confidence,
        r.usdIn = $usdIn,
        r.usdOut = $usdOut,
        b.riskScore = CASE WHEN b.riskScore IS NULL THEN a.riskScore ELSE b.riskScore END,
        b.tags = coalesce(b.tags, []) + ['CROSS_CHAIN_FLIGHT']
  `;

  await runInTransaction('WRITE', async (tx) => {
    await tx.run(query, {
      normSource,
      displaySource: toChecksum(normSource),
      normTarget,
      displayTarget: toChecksum(normTarget),
      bridge,
      timeDelta,
      confidence,
      usdIn,
      usdOut
    });
  });

  try {
    const keys = await redis.keys(`trace:result:${normSource}:*`);
    for (const key of keys) {
      await redis.del(key);
    }
  } catch (_) {}
}

/**
 * Helper: Zero-cost price conversion utility using CoinGecko Free API.
 * In a real loop, you'd rate-limit this to ~10-30 req/min.
 */
export async function fetchPriceUsd(coinId = 'ethereum') {
  return crossChainLimiter(async () => {
    try {
      // Example: https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd
      const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
      const data = await response.json();
      return data[coinId]?.usd || 0;
    } catch (err) {
      logger.error(`[CrossChain] Price fetch failed: ${err.message}`);
      return 0;
    }
  });
}
