/**
 * lib/addresses.js
 * ---------------------------------------------------------------------------
 * Address hygiene. Every address entering or leaving the system passes through
 * here.
 *
 * The rule enforced across the whole codebase:
 *   - STORE and COMPARE lowercase       (`normalizeAddress`)
 *   - DISPLAY EIP-55 checksummed        (`toChecksum`)
 *
 * This matters more than it looks. Ethereum addresses are case-insensitive but
 * EIP-55 encodes a checksum in the capitalisation, so the same wallet can arrive
 * as three different strings from three different sources. If we key Neo4j
 * `Wallet` nodes on the raw string, Phase 2's MERGE silently creates duplicate
 * nodes for one wallet and Phase 3's shortestPath then fails to find a path that
 * plainly exists. Normalising at the boundary prevents that entire class of bug.
 */

import { getAddress, isAddress } from 'ethers';

/** Thrown for caller-supplied addresses that are not valid. Maps to HTTP 400. */
export class InvalidAddressError extends Error {
  /** @param {unknown} value The offending input. */
  constructor(value) {
    super(
      `"${String(value)}" is not a valid Ethereum address. ` +
        'Expected 42 characters: "0x" followed by 40 hexadecimal digits.'
    );
    this.name = 'InvalidAddressError';
    this.statusCode = 400;
    this.value = value;
  }
}

/** Cheap structural check: 0x + exactly 40 hex digits. */
const HEX40 = /^0x[0-9a-fA-F]{40}$/i;

/** BTC structural check: legacy, P2SH, and Bech32 */
const BTC_ADDR = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i;

/**
 * Is this a usable address? Accepts any casing.
 *
 * We intentionally do NOT use ethers' `isAddress` alone: it rejects mixed-case
 * addresses whose EIP-55 checksum is wrong. Victim-reported addresses are
 * routinely copied out of WhatsApp forwards, screenshots and OCR, which mangles
 * capitalisation. Rejecting those would be hostile to the actual user - a police
 * officer typing in what a complainant sent them. So we accept structurally
 * valid input and normalise it ourselves.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidAddress(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return HEX40.test(trimmed) || BTC_ADDR.test(trimmed);
}

/**
 * Canonical storage/comparison form: trimmed and lowercased.
 * @param {unknown} value
 * @returns {string} lowercase 0x-prefixed address
 * @throws {InvalidAddressError}
 */
export function normalizeAddress(value) {
  if (!isValidAddress(value)) throw new InvalidAddressError(value);
  const trimmed = value.trim();
  // ETH addresses are lowercased for storage/comparison.
  // BTC addresses (Base58) are case-sensitive and must NOT be lowercased.
  // Bech32 (bc1) is technically case-insensitive but conventionally lowercased,
  // however we'll just keep all BTC addresses in their provided casing to be safe.
  if (HEX40.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

/**
 * Same as `normalizeAddress` but returns null instead of throwing.
 * Used on RPC payloads, where a null `to` is legitimate (contract creation) and
 * should be skipped rather than treated as an error.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeAddressOrNull(value) {
  if (!isValidAddress(value)) return null;
  const trimmed = value.trim();
  if (HEX40.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

/**
 * EIP-55 checksummed form, for display in API responses and the Phase 4 UI.
 * Falls back to the input on failure so a rendering concern can never break a
 * trace that is otherwise fine.
 *
 * @param {string} value
 * @returns {string}
 */
export function toChecksum(value) {
  const trimmed = String(value).trim();
  if (BTC_ADDR.test(trimmed)) return trimmed; // BTC has no EIP-55
  try {
    return getAddress(trimmed.toLowerCase());
  } catch {
    return String(value);
  }
}

/**
 * Abbreviated form for tight UI space: 0x28C6...1d60
 * @param {string} value
 * @param {number} [lead=6] Characters after 0x to keep.
 * @param {number} [tail=4] Trailing characters to keep.
 */
export function shortenAddress(value, lead = 6, tail = 4) {
  const checksummed = toChecksum(value);
  if (checksummed.length <= 2 + lead + tail) return checksummed;
  
  if (BTC_ADDR.test(checksummed)) {
    // For BTC, don't keep '0x', just first N chars
    return `${checksummed.slice(0, lead)}...${checksummed.slice(-tail)}`;
  }
  return `${checksummed.slice(0, 2 + lead)}...${checksummed.slice(-tail)}`;
}

/** Re-exported so callers never need to import ethers directly for this. */
export { isAddress as isChecksumValid };
