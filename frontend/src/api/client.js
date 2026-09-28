/**
 * api/client.js
 * ---------------------------------------------------------------------------
 * Thin fetch wrapper for the CryptoTrace backend.
 *
 * Every function returns a parsed JSON body on success and throws a typed
 * error on failure so the calling hooks can set state cleanly.
 */

import { API_BASE } from '../utils/constants.js';

/**
 * Custom error carrying the HTTP status and backend error body.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {object|null} body
   */
  constructor(message, status, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Internal fetch helper.
 *
 * @param {string} path   Path relative to `API_BASE`, e.g. `/api/trace/0x…`.
 * @param {object} [opts] Fetch options.
 * @returns {Promise<any>} Parsed JSON body.
 */
async function request(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);

  try {
    const headers = { 
      'X-Requested-With': 'XMLHttpRequest',
      ...opts.headers 
    };
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'include', // Crucial for sending the HttpOnly session cookie
      ...opts,
      headers,
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
      throw new ApiError(message, response.status, body);
    }

    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      throw new ApiError('Request timed out', 0);
    }
    throw new ApiError(error.message ?? 'Network error', 0);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const auth = {
  login: async (email, password) => {
    return request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  },
  logout: async () => {
    return request('/api/auth/logout', { method: 'POST' });
  },
  me: async () => {
    return request('/api/auth/me');
  },
};

/**
 * Trace a wallet address to find cash-out exchanges.
 *
 * This is the Phase 3 query: `GET /api/trace/:address`.
 *
 * @param {string} address  Ethereum address (any casing).
 * @param {object} [options]
 * @param {number} [options.maxHops=15]
 */

/**
 * Consume Server-Sent Events (SSE) via native EventSource.
 */
async function consumeSSE(endpoint, onProgress) {
  const url = import.meta.env.VITE_API_URL 
    ? `${import.meta.env.VITE_API_URL}${endpoint}` 
    : endpoint;

  return new Promise((resolve) => {
    const es = new EventSource(url);
    
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onProgress(data);
        if (data.stage === 'done' || data.stage === 'error') {
          es.close();
          resolve();
        }
      } catch (e) {}
    };

    es.onerror = (err) => {
      console.warn('SSE EventSource failed or closed', err);
      es.close();
      resolve();
    };
  });
}

/**
 * Initiates a full pipeline trace (Graph pathfinding + on-chain fallback).
 * 
 * @param {string} address The wallet address to trace
 * @param {object} options Query parameters (maxHops, context, etc)
 * @param {function} [onProgress] Callback for SSE progress events
 * @returns {Promise<object>} The trace response payload
 */
export async function traceAddress(address, options = {}, onProgress = null) {
  const params = new URLSearchParams();
  if (options.maxHops) params.append('maxHops', options.maxHops);
  if (options.context === false) params.append('context', 'false');

  const qs = params.toString();
  const endpoint = `/api/trace/${address}${qs ? `?${qs}` : ''}`;
  
  const response = await request(endpoint, { timeoutMs: 30_000 });

  if (response.status === 'processing' && response.jobId) {
    if (onProgress) {
      await consumeSSE(`/api/trace/stream/${response.jobId}`, onProgress);
    }
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      const pollResponse = await request(`/api/trace/status/${response.jobId}`, { timeoutMs: 10_000 });
      if (pollResponse.status !== 'processing') {
        // The backend returns the raw trace payload when it completes
        return pollResponse;
      }
    }
  }

  return response;
}

/**
 * Submits a mock complaint to trigger the ingestion and risk pipeline.
 * @param {object} payload - The complaint details
 * @param {function} [onProgress] - Callback for SSE progress events
 */
export async function ingestComplaint(payload, onProgress = null) {
  const response = await request('/api/complaints/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 15_000
  });

  if (response.status === 'processing' && response.jobId) {
    if (onProgress) {
      await consumeSSE(`/api/complaints/stream/${response.jobId}`, onProgress);
    }
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      const pollResponse = await request(`/api/complaints/status/${response.jobId}`, { timeoutMs: 10_000 });
      if (pollResponse.status !== 'processing') {
        return pollResponse;
      }
    }
  }

  return response;
}

/**
 * Fetch backend health status.
 *
 * @returns {Promise<object>}
 */
export async function fetchHealth() {
  return request('/health', { timeoutMs: 5_000 });
}

/**
 * Fetch backend configuration (traversal limits, exchange registry, risk model).
 *
 * @returns {Promise<object>}
 */
export async function fetchConfig() {
  return request('/api/config', { timeoutMs: 5_000 });
}

export { request as fetchJson };
