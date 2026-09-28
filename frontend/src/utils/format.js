/**
 * utils/format.js
 * ---------------------------------------------------------------------------
 * Display-oriented helpers. Every function here is pure and side-effect free.
 */

import { ETHERSCAN_BASE } from './constants.js';

/**
 * Shorten an Ethereum address for display: `0x1234…ABCD`.
 * Returns the original string if it is already short enough.
 *
 * @param {string} addr
 * @param {number} [head=6]
 * @param {number} [tail=4]
 * @returns {string}
 */
export function shortenAddress(addr, head = 6, tail = 4) {
  if (!addr || addr.length <= head + tail + 1) return addr ?? '';
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * Format a numeric amount with locale-aware separators and an asset suffix.
 *
 * @param {number} n
 * @param {string} [asset]
 * @param {number} [decimals=4]
 * @returns {string}
 */
export function formatAmount(n, asset, decimals = 4) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return asset ? `${formatted} ${asset}` : formatted;
}

/**
 * Format a UNIX timestamp (seconds) into a readable datetime string.
 *
 * @param {number} epoch  Seconds since Unix epoch.
 * @returns {string}
 */
export function formatTimestamp(epoch) {
  if (!epoch) return '—';
  const date = new Date(epoch * 1000);
  return date.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Build a block explorer URL (Etherscan for ETH, Mempool for BTC).
 *
 * @param {string} value   Transaction hash or wallet address.
 * @param {'tx'|'address'} [type='tx']
 * @returns {string}
 */
export function etherscanUrl(value, type = 'tx') {
  if (!value) return '#';
  
  // Detect BTC formats:
  // 1. BTC Tx: 64 char hex string without 0x prefix
  // 2. BTC Address: starts with 1, 3, or bc1
  const isBtcTx = /^[a-fA-F0-9]{64}$/.test(value);
  const isBtcAddress = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(value);

  if (isBtcTx || isBtcAddress) {
    return `https://mempool.space/${type}/${value}`;
  }

  return `${ETHERSCAN_BASE}/${type}/${value}`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
