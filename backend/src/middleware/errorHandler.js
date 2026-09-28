/**
 * middleware/errorHandler.js
 * ---------------------------------------------------------------------------
 * Centralised error handling. Two exports:
 *
 *   - `notFoundHandler` for unmatched routes
 *   - `errorHandler`    the terminal Express error middleware
 *
 * Principle: every error leaves this service as JSON with a stable shape, a
 * meaningful HTTP status, and no stack trace in production. The Phase 4 frontend
 * can then render failures without special-casing HTML error pages.
 */

import { logger } from '../lib/logger.js';
import { config } from '../config/env.js';

/**
 * Map an internal error onto an HTTP status code.
 *
 * Errors thrown deeper in the stack carry a `statusCode` (InvalidAddressError
 * uses 400, RpcRetryError uses 503). Anything unrecognised is a genuine bug and
 * becomes a 500.
 *
 * @param {any} error
 * @returns {number}
 */
function resolveStatus(error) {
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600) {
    return error.statusCode;
  }
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
    return error.status;
  }
  // Express' own body-parser errors.
  if (error?.type === 'entity.parse.failed') return 400;
  return 500;
}

/**
 * A short machine-readable code so the UI can branch on failure type without
 * string-matching human-readable messages.
 * @param {any} error
 * @param {number} status
 */
function resolveCode(error, status) {
  if (error?.name === 'InvalidAddressError') return 'INVALID_ADDRESS';
  if (error?.name === 'RpcRetryError') return 'UPSTREAM_RPC_UNAVAILABLE';
  if (error?.name === 'GraphDisabledError') return 'GRAPH_DISABLED';
  if (error?.name === 'GraphUnavailableError') {
    // The same error class covers "database is down" (503) and "we sent bad
    // Cypher" (500). Those need different codes, because only one of them is
    // something the operator can fix.
    return status >= 500 && status < 503 ? 'GRAPH_WRITE_FAILED' : 'GRAPH_UNAVAILABLE';
  }
  if (status === 404) return 'NOT_FOUND';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 408) return 'REQUEST_TIMEOUT';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

/**
 * Actionable remediation hints. These exist because the two failure modes you
 * will actually hit during a hackathon - a missing API key and an exhausted rate
 * limit - look identical from the frontend otherwise, and you do not want to be
 * debugging that distinction in front of judges.
 *
 * @param {string} code
 * @param {any} error
 * @returns {string|undefined}
 */
function resolveHint(code, error) {
  switch (code) {
    case 'INVALID_ADDRESS':
      return 'Provide a 42-character address: "0x" followed by 40 hex digits.';
    case 'UPSTREAM_RPC_UNAVAILABLE':
      return (
        'The blockchain RPC provider could not be reached or rate-limited every retry. ' +
        'Check ALCHEMY_API_KEY and your Alchemy dashboard quota, lower RPC_CONCURRENCY, ' +
        'or set MOCK_MODE=true to run the offline demo dataset.'
      );
    case 'REQUEST_TIMEOUT':
      return 'Reduce ?depth or lower MAX_FANOUT_PER_ADDRESS; wide traces take longer.';
    case 'GRAPH_UNAVAILABLE':
      return (
        error?.hint ??
        'Neo4j could not be reached. Start the DBMS in Neo4j Desktop, then check ' +
          'NEO4J_URI (Bolt port 7687, not the Browser port 7474) and NEO4J_PASSWORD ' +
          'in backend/.env. Set GRAPH_ENABLED=false to run without the graph.'
      );
    case 'GRAPH_DISABLED':
      return 'Set GRAPH_ENABLED=true in backend/.env and provide NEO4J_PASSWORD.';
    default:
      return error?.hint;
  }
}

/** 404 for routes that matched nothing. Must be registered after all routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}`,
    },
    availableRoutes: [
      'GET /health',
      'GET /api/config',
      'GET /api/history/:address?depth=3',
      'GET /api/trace/:address?maxHops=15',
      'GET /api/graph/stats',
      'GET /api/graph/schema',
    ],
  });
}

/**
 * Terminal Express error middleware.
 * The four-argument signature is required - Express identifies error handlers by
 * arity, so `next` must stay even though it is unused.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  const status = resolveStatus(error);
  const code = resolveCode(error, status);

  // 5xx means we broke; log loudly with the stack. 4xx means the caller sent
  // something invalid, which is routine and does not warrant error-level noise.
  const logPayload = {
    code,
    status,
    method: req.method,
    path: req.originalUrl,
    message: error?.message,
  };

  if (status >= 500) {
    logger.error('Request failed', { ...logPayload, stack: error?.stack });
  } else {
    logger.warn('Request rejected', logPayload);
  }

  const body = {
    ok: false,
    error: {
      code,
      message: error?.message ?? 'An unexpected error occurred.',
      ...(resolveHint(code, error) ? { hint: resolveHint(code, error) } : {}),
    },
  };

  // Stacks are a debugging aid locally and an information leak in production.
  if (!config.isProduction && error?.stack) {
    body.error.stack = String(error.stack).split('\n').slice(0, 12);
  }

  // If headers already went out (e.g. a stream failed mid-response) we cannot
  // send a body; just terminate the connection cleanly.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(status).json(body);
}

/**
 * Wrap an async route handler so a rejected promise reaches `errorHandler`.
 *
 * Express 4 does not catch rejections from async handlers - without this an
 * unhandled rejection hangs the request until the client times out, which is a
 * miserable failure mode to debug live. Express 5 fixes it, but we are on 4.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} handler
 */
export function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
