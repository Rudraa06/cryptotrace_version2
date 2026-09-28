/**
 * lib/chainProviders.js
 * ---------------------------------------------------------------------------
 * Lazy per-chain provider pool for multi-chain tracing (Phase 4).
 *
 * The default chain's provider (created by provider.js) is a process-level
 * singleton shared by all existing services and is left completely untouched.
 * This module manages ADDITIONAL providers for secondary chains (Polygon, BSC)
 * without disturbing that singleton.
 *
 * All secondary chains share the same ALCHEMY_API_KEY — Alchemy supports
 * eth-mainnet, polygon-mainnet, and bnb-mainnet under one key.  If a future
 * chain requires a dedicated key, add a `keyEnvVar` field to SUPPORTED_SECONDARY_CHAINS.
 */

import { JsonRpcProvider, Network } from 'ethers';
import { config } from '../config/env.js';
import { buildAssetRegistry, buildTransferCategories } from '../config/assets.js';
import { withRetry } from './retry.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Supported secondary chains
// ---------------------------------------------------------------------------

/**
 * EVM chains we support beyond the boot-time default.
 * 'eth-mainnet' is intentionally absent — it is served by provider.js.
 *
 * @type {Record<string, { chainId: number, alchemySlug: string }>}
 */
export const SUPPORTED_SECONDARY_CHAINS = Object.freeze({
  'polygon-mainnet': { chainId: 137,       alchemySlug: 'polygon-mainnet' },
  'bnb-mainnet':     { chainId: 56,        alchemySlug: 'bnb-mainnet'     },
  'eth-sepolia':     { chainId: 11155111,  alchemySlug: 'eth-sepolia'     },
});

/**
 * @typedef {object} ChainContext
 * @property {JsonRpcProvider} provider
 * @property {ReturnType<import('../config/assets.js').buildAssetRegistry>} assets
 * @property {string[]} categories  Alchemy transfer categories to request.
 * @property {string}   rpcUrl      Redacted in logs; full URL kept for debugging.
 */

/** @type {Map<string, ChainContext>} */
const chainContexts = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get (and lazily create) the chain context for `networkSlug`.
 *
 * Returns `null` when:
 *   - `config.mockMode` is true (no network access in mock mode)
 *   - the slug is not in SUPPORTED_SECONDARY_CHAINS
 *   - ALCHEMY_API_KEY is not set
 *
 * @param {string} networkSlug e.g. 'polygon-mainnet'
 * @returns {ChainContext | null}
 */
export function getChainContext(networkSlug) {
  if (config.mockMode) return null;

  const meta = SUPPORTED_SECONDARY_CHAINS[networkSlug];
  if (!meta) {
    logger.debug('getChainContext: unsupported secondary chain', { networkSlug });
    return null;
  }

  if (chainContexts.has(networkSlug)) return chainContexts.get(networkSlug);

  if (!config.alchemyApiKey) {
    logger.warn('getChainContext: ALCHEMY_API_KEY not set; cannot create secondary chain provider', {
      network: networkSlug,
    });
    return null;
  }

  const rpcUrl    = `https://${meta.alchemySlug}.g.alchemy.com/v2/${config.alchemyApiKey}`;
  const staticNet = Network.from(meta.chainId);

  const provider = new JsonRpcProvider(rpcUrl, staticNet, {
    staticNetwork: staticNet,
    batchMaxCount: 1,   // same reasoning as provider.js: unambiguous 429 handling
    polling:       false,
  });

  const assets     = buildAssetRegistry(networkSlug);
  const categories = buildTransferCategories(config);

  const ctx = { provider, assets, categories, rpcUrl };
  chainContexts.set(networkSlug, ctx);

  logger.info('Secondary chain provider initialised', {
    network: networkSlug,
    chainId: meta.chainId,
    endpoint: rpcUrl.replace(/\/v2\/.*$/, '/v2/***'),
  });

  return ctx;
}

/**
 * Fetch raw Alchemy asset transfers for `address` on `networkSlug`.
 *
 * Same semantics as `fetchOutgoingTransfersLive` in assetTransfers.js but
 * scoped to a secondary chain.  Returns `[]` (never throws) on any failure
 * so a secondary-chain error never takes down the primary trace.
 *
 * @param {string}  networkSlug
 * @param {string}  address      Lowercase Ethereum address.
 * @param {object}  [options]
 * @param {number}  [options.maxTransfers]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object[]>}  Raw Alchemy-shaped transfers.
 */
export async function fetchTransfersForChain(networkSlug, address, options = {}) {
  const ctx = getChainContext(networkSlug);
  if (!ctx) return [];

  const maxTransfers = options.maxTransfers ?? config.maxTransfersPerAddress;
  const collected    = [];
  let   pageKey;
  let   page = 0;
  const MAX_PAGES = 10;

  do {
    const remaining = maxTransfers - collected.length;
    if (remaining <= 0) break;

    const params = [
      {
        fromAddress:      address,
        category:         ctx.categories,
        withMetadata:     true,
        excludeZeroValue: true,
        order:            'desc',
        maxCount:         `0x${Math.min(remaining, 1000).toString(16)}`,
        ...(pageKey ? { pageKey } : {}),
      },
    ];

    try {
      const response = await withRetry(
        () => ctx.provider.send('alchemy_getAssetTransfers', params),
        {
          maxRetries:   config.rpcMaxRetries,
          baseDelayMs:  config.rpcBaseBackoffMs,
          label:        `chain:${networkSlug}:getAssetTransfers(${address.slice(0, 10)}...)`,
          signal:       options.signal,
        }
      );

      const transfers = Array.isArray(response?.transfers) ? response.transfers : [];
      collected.push(...transfers);
      pageKey = response?.pageKey;
      page   += 1;
    } catch (err) {
      logger.warn('fetchTransfersForChain: RPC error', {
        network: networkSlug,
        address: address.slice(0, 10),
        reason:  err?.message?.slice(0, 200),
      });
      break; // fail open — return what we have
    }
  } while (pageKey && collected.length < maxTransfers && page < MAX_PAGES);

  return collected;
}

/**
 * Tear down all secondary chain providers on process shutdown.
 * Call from app.js alongside `destroyProvider()`.
 */
export function destroyChainProviders() {
  for (const [slug, ctx] of chainContexts) {
    try {
      ctx.provider.destroy();
    } catch (_) {
      // best-effort
    }
    logger.debug('Secondary chain provider destroyed', { network: slug });
  }
  chainContexts.clear();
}
