/**
 * services/provider.js
 * ---------------------------------------------------------------------------
 * The single shared `ethers.JsonRpcProvider` for the process.
 *
 * Deliberate configuration choices:
 *
 *  - `staticNetwork`: tells ethers the chain ID will never change, so it stops
 *    issuing an `eth_chainId` probe before every call. On a multi-hop trace
 *    that removes hundreds of wasted round trips and a meaningful slice of your
 *    Alchemy compute-unit budget.
 *
 *  - `batchMaxCount: 1`: disables JSON-RPC request batching. Batching sounds
 *    like a win, but Alchemy bills and rate-limits per method inside the batch
 *    while returning a single HTTP status, which makes 429 handling ambiguous -
 *    we cannot tell which sub-request was throttled. One request per call keeps
 *    our retry logic exact. Our own concurrency limiter provides the throughput.
 *
 *  - Lazy construction: in MOCK_MODE no provider is ever built, so the service
 *    runs with no API key and no network at all.
 */

import { JsonRpcProvider, Network } from 'ethers';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';

/** Chain IDs for the networks we support, used to pin `staticNetwork`. */
const CHAIN_IDS = {
  'eth-mainnet': 1,
  'eth-sepolia': 11155111,
  'polygon-mainnet': 137,
  'base-mainnet': 8453,
  'arb-mainnet': 42161,
};

/** @type {JsonRpcProvider|null} */
let providerInstance = null;

/**
 * Get (and on first call, create) the shared provider.
 *
 * @returns {JsonRpcProvider}
 * @throws {Error} if called in MOCK_MODE or without an RPC URL configured.
 */
export function getProvider() {
  if (config.mockMode) {
    throw new Error(
      'getProvider() called while MOCK_MODE=true. Mock mode must not reach the network - ' +
        'this indicates a code path that failed to check config.mockMode.'
    );
  }

  if (!config.rpcUrl) {
    const error = new Error(
      'No RPC URL configured. Set ALCHEMY_API_KEY in backend/.env, or set RPC_URL directly.'
    );
    error.statusCode = 500;
    throw error;
  }

  if (providerInstance) return providerInstance;

  const chainId = CHAIN_IDS[config.network];
  const staticNetwork = chainId ? Network.from(chainId) : undefined;

  if (!chainId) {
    // Not fatal - ethers will discover the chain ID itself, just less efficiently.
    logger.warn('Unrecognised network slug; falling back to chain-ID auto-detection', {
      network: config.network,
      supported: Object.keys(CHAIN_IDS),
    });
  }

  providerInstance = new JsonRpcProvider(config.rpcUrl, staticNetwork, {
    staticNetwork,
    batchMaxCount: 1,
    // Fail a stalled socket rather than hanging the whole trace indefinitely.
    // Our retry wrapper will then decide whether to try again.
    polling: false,
  });

  logger.info('RPC provider initialised', {
    network: config.network,
    chainId: chainId ?? 'auto',
    endpoint: config.rpcUrl.replace(/\/v2\/.*$/, '/v2/***'),
  });

  return providerInstance;
}

/**
 * Issue a raw JSON-RPC call with retry/backoff applied.
 *
 * All outbound RPC traffic in this service funnels through here, which means
 * rate-limit handling exists in exactly one place.
 *
 * @param {string} method JSON-RPC method name, e.g. 'alchemy_getAssetTransfers'
 * @param {unknown[]} params
 * @param {{ label?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function rpcSend(method, params, options = {}) {
  const provider = getProvider();
  return withRetry(() => provider.send(method, params), {
    maxRetries: config.rpcMaxRetries,
    baseDelayMs: config.rpcBaseBackoffMs,
    label: options.label ?? method,
    signal: options.signal,
  });
}

/**
 * Connectivity probe used by `GET /health`.
 *
 * Returns a plain object instead of throwing so the health endpoint can report
 * "degraded" rather than 500 - useful when you want to know the server is up
 * but Alchemy is unreachable.
 *
 * @returns {Promise<{ ok: boolean, mode: string, network: string, blockNumber?: number, error?: string }>}
 */
export async function checkRpcHealth() {
  if (config.mockMode) {
    return { ok: true, mode: 'mock', network: config.network };
  }

  try {
    const provider = getProvider();
    const blockNumber = await withRetry(() => provider.getBlockNumber(), {
      maxRetries: 1,
      baseDelayMs: 250,
      label: 'health:getBlockNumber',
    });
    return { ok: true, mode: 'live', network: config.network, blockNumber };
  } catch (error) {
    return {
      ok: false,
      mode: 'live',
      network: config.network,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * Tear down sockets on shutdown so `npm run dev` restarts cleanly and the
 * process does not linger holding keep-alive connections.
 */
export function destroyProvider() {
  if (!providerInstance) return;
  try {
    providerInstance.destroy();
    logger.debug('RPC provider destroyed');
  } catch (error) {
    logger.warn('Error while destroying provider', { reason: error?.message });
  } finally {
    providerInstance = null;
  }
}
