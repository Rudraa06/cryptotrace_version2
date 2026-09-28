/**
 * lib/retry.js
 * ---------------------------------------------------------------------------
 * Exponential backoff with full jitter, purpose-built for Alchemy.
 *
 * Why this exists: `alchemy_getAssetTransfers` costs 150 compute units. On the
 * free tier (~330 CU/second) a multi-hop trace will reliably trip HTTP 429.
 * A naive implementation crashes the request and the demo dies on stage. We
 * instead classify the failure and retry only when retrying can actually help.
 *
 * Full jitter (random between 0 and the cap) rather than fixed backoff is
 * deliberate: when the BFS frontier fans out, a dozen calls fail at the same
 * instant, and fixed backoff would make them all retry in lockstep and trip the
 * limiter again. Jitter spreads them out.
 */

import { logger } from './logger.js';

/** Error thrown when every retry attempt has been exhausted. */
export class RpcRetryError extends Error {
  /**
   * @param {string} message
   * @param {{ attempts: number, lastError: unknown, retryable: boolean }} details
   */
  constructor(message, details) {
    super(message);
    this.name = 'RpcRetryError';
    this.attempts = details.attempts;
    this.lastError = details.lastError;
    this.retryable = details.retryable;
    // Surfaced by the Express error handler as 503 - upstream unavailable.
    this.statusCode = 503;
  }
}

/**
 * Decide whether an error is worth retrying.
 *
 * Retryable: rate limits (429), gateway/server errors (5xx), socket resets and
 * timeouts, and ethers' own transient network classifications.
 * NOT retryable: 400/401/403 (bad request, bad or over-quota API key) and
 * malformed-params JSON-RPC errors (-32602). Retrying those just wastes the
 * demo clock and hides the real problem.
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (!error) return false;

  // ethers v6 attaches a machine-readable `code` to its errors.
  const ethersCode = error.code;
  if (
    ethersCode === 'NETWORK_ERROR' ||
    ethersCode === 'TIMEOUT' ||
    ethersCode === 'SERVER_ERROR' ||
    ethersCode === 'ECONNRESET' ||
    ethersCode === 'ETIMEDOUT' ||
    ethersCode === 'ECONNREFUSED' ||
    ethersCode === 'EAI_AGAIN' ||
    ethersCode === 'UND_ERR_SOCKET' ||
    ethersCode === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }

  // HTTP status, wherever it happens to be hiding.
  const status =
    error.status ??
    error.statusCode ??
    error.response?.status ??
    error.info?.status ??
    null;

  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;

  // JSON-RPC error bodies. Alchemy uses -32005 for "limit exceeded".
  const rpcCode = error.error?.code ?? error.info?.error?.code ?? null;
  if (rpcCode === -32005) return true;
  if (rpcCode === -32602 || rpcCode === -32600) return false;

  // Last resort: match the message text. Kept narrow on purpose.
  const message = String(error.message ?? error).toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429') ||
    message.includes('capacity') ||
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('fetch failed')
  );
}

/**
 * If the upstream told us exactly how long to wait, honour it.
 * @param {any} error
 * @returns {number|null} milliseconds, or null when absent
 */
function retryAfterMs(error) {
  const header =
    error?.response?.headers?.get?.('retry-after') ??
    error?.info?.headers?.['retry-after'] ??
    error?.headers?.['retry-after'] ??
    null;
  if (!header) return null;

  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);

  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), 30_000);
  }
  return null;
}

/** Promise-based sleep. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task`, retrying transient failures with exponential backoff + jitter.
 *
 * @template T
 * @param {() => Promise<T>} task The operation to attempt.
 * @param {object} [options]
 * @param {number} [options.maxRetries=5]   Retries *after* the first attempt.
 * @param {number} [options.baseDelayMs=400]
 * @param {number} [options.maxDelayMs=15000]
 * @param {string} [options.label='rpc']    Shown in logs for traceability.
 * @param {AbortSignal} [options.signal]    Cancels pending backoff waits.
 * @returns {Promise<T>}
 */
export async function withRetry(task, options = {}) {
  const {
    maxRetries = 5,
    baseDelayMs = 400,
    maxDelayMs = 15_000,
    label = 'rpc',
    signal,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new RpcRetryError(`${label} aborted before attempt ${attempt + 1}`, {
        attempts: attempt,
        lastError: signal.reason ?? new Error('aborted'),
        retryable: false,
      });
    }

    try {
      return await task();
    } catch (error) {
      lastError = error;

      const retryable = isRetryable(error);
      const attemptsLeft = maxRetries - attempt;

      // Give up immediately on permanent failures - no point burning the clock.
      if (!retryable || attemptsLeft <= 0) {
        throw new RpcRetryError(
          `${label} failed after ${attempt + 1} attempt(s): ${error?.message ?? error}`,
          { attempts: attempt + 1, lastError: error, retryable }
        );
      }

      // Exponential ceiling, then full jitter within it.
      const ceiling = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jittered = Math.floor(Math.random() * ceiling);
      const delay = retryAfterMs(error) ?? Math.max(jittered, baseDelayMs / 2);

      logger.warn(`${label} transient failure, backing off`, {
        attempt: attempt + 1,
        of: maxRetries + 1,
        delayMs: delay,
        reason: String(error?.message ?? error).slice(0, 160),
      });

      await sleep(delay);
    }
  }

  // Unreachable, but keeps static analysers and future refactors honest.
  throw new RpcRetryError(`${label} exhausted retries`, {
    attempts: maxRetries + 1,
    lastError,
    retryable: true,
  });
}
