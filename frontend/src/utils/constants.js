/**
 * utils/constants.js
 * ---------------------------------------------------------------------------
 * Shared constants for the CryptoTrace frontend. Mirrors the backend's own
 * role definitions so the two never drift apart.
 */

/** Backend base URL. Empty in dev to use the Vite proxy. */
export const API_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Node visual roles, mirrored from backend's `lib/forceGraph.js`.
 * The backend serves the colour palette alongside every trace, so the legend
 * and the canvas are always consistent — but we keep local copies for any
 * rendering logic that runs before the first API call.
 */
export const NODE_ROLES = Object.freeze({
  SOURCE: 'source',
  INTERMEDIARY: 'intermediary',
  EXCHANGE: 'exchange',
  CONTEXT: 'context',
});

/** Fallback palette (overridden by `forceGraph.legend` from the backend). */
export const ROLE_COLORS = Object.freeze({
  [NODE_ROLES.SOURCE]: '#22c55e',
  [NODE_ROLES.INTERMEDIARY]: '#94a3b8',
  [NODE_ROLES.EXCHANGE]: '#ef4444',
  [NODE_ROLES.CONTEXT]: '#475569',
});

/** Etherscan base URL for tx / address links. */
export const ETHERSCAN_BASE = 'https://etherscan.io';
