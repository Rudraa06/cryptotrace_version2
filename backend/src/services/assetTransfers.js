/**
 * services/assetTransfers.js
 * ---------------------------------------------------------------------------
 * Client for Alchemy's `alchemy_getAssetTransfers`, plus normalisation of its
 * output into this project's canonical transfer shape.
 *
 * WHY THIS METHOD, AND NOT PLAIN ethers CALLS
 * -------------------------------------------
 * A question a judge may well ask, so it is worth knowing the answer. Standard
 * Ethereum JSON-RPC has no "give me this address's transaction history" call.
 * There is `eth_getTransactionByHash`, `eth_getBlockByNumber`, and so on - all
 * keyed by hash or block, never by participant. Reconstructing one wallet's
 * history from base RPC means scanning every block since genesis (23M+ blocks),
 * which is completely infeasible inside a request.
 *
 * Alchemy's enhanced `alchemy_getAssetTransfers` maintains exactly the index we
 * need: transfers filtered by `fromAddress`/`toAddress`. We reach it through
 * `ethers.JsonRpcProvider.send()`, so ethers.js remains our transport and the
 * stack constraint holds.
 *
 * NORMALISATION IS SHARED BY LIVE AND MOCK PATHS
 * ----------------------------------------------
 * The fixture file stores raw Alchemy-shaped payloads, not pre-cooked results.
 * So MOCK_MODE exercises the same parser as production - a bug in amount or
 * timestamp handling shows up in your offline demo instead of hiding until you
 * are live on stage.
 */

import { formatUnits } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config/env.js';
import { buildAssetRegistry, buildTransferCategories } from '../config/assets.js';
import { normalizeAddress, normalizeAddressOrNull } from '../lib/addresses.js';
import { logger } from '../lib/logger.js';
import { rpcSend } from './provider.js';

/** Asset tables for the configured network, built once. */
export const assets = buildAssetRegistry(config.network);

/** Alchemy transfer categories we request, built once. */
const CATEGORIES = buildTransferCategories(config);

/** Alchemy caps `maxCount` at 1000 per page. */
const ALCHEMY_MAX_PAGE_SIZE = 1000;

/**
 * @typedef {object} Transfer Canonical shape consumed by the traversal and, in
 *   Phase 2, by `ingestToGraph`. Field names line up with the Neo4j schema:
 *   `hash`, `amount`, `timestamp`, `blockNumber` map straight onto TRANSACTION.
 * @property {string} hash        Transaction hash.
 * @property {string} uniqueId    Alchemy per-transfer id (see note in dedupe).
 * @property {string} from        Lowercase sender.
 * @property {string} to          Lowercase recipient.
 * @property {number} amount      Human-readable amount (decimals applied).
 * @property {string} asset       Symbol, e.g. 'ETH', 'USDT'.
 * @property {'native'|'stablecoin'} assetClass
 * @property {string|null} contract Token contract, null for the native coin.
 * @property {number} blockNumber
 * @property {number} timestamp   Unix seconds.
 * @property {string} category    'external' | 'erc20' | 'internal'
 */

// --- Value / metadata parsing ---------------------------------------------

/**
 * Convert a transfer's raw on-chain value into a human-readable number.
 *
 * We prefer `rawContract.value` (an exact hex integer) over the convenience
 * `value` float that Alchemy also returns, because the convenience field is
 * pre-rounded. For a 6-decimal token like USDT that rounding can quietly lose
 * paise - unacceptable in something intended as investigative evidence.
 *
 * Note the deliberate `Number()` at the end: the Neo4j schema types `amount` as
 * Float, so a float is what we must produce. IEEE-754 gives ~15 significant
 * digits, which is ample for realistic fraud amounts. If you later need exact
 * accounting arithmetic, carry `rawContract.value` through as a string too and
 * do the maths in BigInt.
 *
 * @param {object} transfer Raw Alchemy transfer.
 * @param {{ decimals: number }} asset Resolved asset metadata.
 * @returns {number}
 */
function parseAmount(transfer, asset) {
  const raw = transfer?.rawContract?.value;

  if (typeof raw === 'string' && /^0x[0-9a-fA-F]*$/.test(raw) && raw !== '0x') {
    // Alchemy reports decimals as a hex string ('0x12' = 18). Fall back to the
    // allowlist's known decimals when the field is absent or unparseable.
    let decimals = asset.decimals;
    const rawDecimals = transfer?.rawContract?.decimal;
    if (typeof rawDecimals === 'string' && /^0x[0-9a-fA-F]+$/.test(rawDecimals)) {
      const parsed = Number(BigInt(rawDecimals));
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 36) decimals = parsed;
    }

    try {
      return Number(formatUnits(BigInt(raw), decimals));
    } catch (error) {
      logger.debug('Falling back to convenience value field', {
        hash: transfer?.hash,
        reason: error?.message,
      });
    }
  }

  return Number.isFinite(transfer?.value) ? Number(transfer.value) : 0;
}

/**
 * Parse a hex block number ('0x11a4e2f') into an integer.
 * @param {unknown} value
 * @returns {number}
 */
function parseBlockNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 16);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

/**
 * Parse `metadata.blockTimestamp` (ISO 8601) into Unix seconds.
 *
 * Requesting `withMetadata: true` is what makes this available inline. The
 * alternative - one `eth_getBlockByNumber` per transfer to look up its time -
 * would multiply our RPC call count by an order of magnitude for no benefit.
 *
 * @param {object} transfer
 * @returns {number} Unix seconds, or 0 when unavailable.
 */
function parseTimestamp(transfer) {
  const iso = transfer?.metadata?.blockTimestamp;
  if (typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Normalise one raw Alchemy transfer, or return null to discard it.
 *
 * Discard reasons, all intentional:
 *   - asset not on the allowlist (airdrop spam, random NFTs)
 *   - missing `to` (contract creation - no recipient wallet to trace to)
 *   - self-transfer (adds a self-loop to the graph and no information)
 *   - amount at or below the asset's dust threshold
 *
 * @param {object} raw
 * @returns {Transfer|null}
 */
export function normalizeTransfer(raw) {
  const asset = assets.resolve(raw);
  if (!asset) return null; // Not an allowlisted asset.

  const from = normalizeAddressOrNull(raw?.from);
  const to = normalizeAddressOrNull(raw?.to);

  // `to === null` is legitimate for contract-creation transactions. There is no
  // recipient wallet, so there is nothing to trace onward to.
  if (!from || !to) return null;

  // Self-transfers (including token-contract self-calls) carry no trace signal.
  if (from === to) return null;

  const amount = parseAmount(raw, asset);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const threshold = assets.dustThreshold(asset, config);
  if (amount < threshold) return null;

  const hash = typeof raw?.hash === 'string' ? raw.hash.toLowerCase() : null;
  if (!hash) return null;

  return {
    hash,
    // `uniqueId` distinguishes multiple transfers inside a single transaction.
    // Alchemy's own format is `${hash}:${category}` (plus a log index for
    // ERC-20s), so we synthesise the same style when it is missing.
    uniqueId:
      typeof raw?.uniqueId === 'string' && raw.uniqueId
        ? raw.uniqueId.toLowerCase()
        : `${hash}:${raw?.category ?? 'external'}`,
    from,
    to,
    amount,
    asset: asset.symbol,
    assetClass: asset.class,
    contract: asset.contract,
    blockNumber: parseBlockNumber(raw?.blockNum ?? raw?.blockNumber),
    timestamp: parseTimestamp(raw),
    category: typeof raw?.category === 'string' ? raw.category : 'external',
  };
}

// --- Mock mode -------------------------------------------------------------

/** Lazily loaded fixture payload, cached for the process lifetime. */
let fixtureCache = null;

/**
 * Load `fixtures/mock-transfers.json`.
 *
 * Shape:
 *   {
 *     "network": "eth-mainnet",
 *     "scenario": "...human-readable description...",
 *     "transfersByAddress": { "0xlowercase": [ <raw alchemy transfer>, ... ] }
 *   }
 */
async function loadFixtures() {
  if (fixtureCache) return fixtureCache;

  const file = path.join(config.paths.fixtures, 'mock-transfers.json');

  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));

    // Re-key defensively: a hand-edited fixture will contain checksummed or
    // mixed-case keys sooner or later, and a silent miss there looks exactly
    // like "the wallet has no outgoing transactions", which is a confusing bug
    // to chase at 3am the night before judging.
    const transfersByAddress = {};
    for (const [address, transfers] of Object.entries(parsed.transfersByAddress ?? {})) {
      transfersByAddress[String(address).toLowerCase()] = Array.isArray(transfers)
        ? transfers
        : [];
    }

    fixtureCache = { ...parsed, transfersByAddress };

    logger.info('Loaded mock fixtures', {
      file: path.relative(config.paths.root, file),
      addresses: Object.keys(transfersByAddress).length,
      scenario: parsed.scenario ?? '(none)',
    });

    return fixtureCache;
  } catch (error) {
    const wrapped = new Error(
      `MOCK_MODE=true but fixtures could not be loaded from ${file}. ` +
        `Run "npm run seed:fixtures" to generate them. Cause: ${error.message}`
    );
    wrapped.statusCode = 500;
    throw wrapped;
  }
}

/**
 * Fixture-backed equivalent of `fetchOutgoingTransfers`.
 * @param {string} address lowercase
 * @returns {Promise<object[]>} raw Alchemy-shaped transfers
 */
async function fetchOutgoingTransfersMock(address) {
  const { transfersByAddress } = await loadFixtures();
  // An unknown address is not an error - it is a leaf node in the fixture graph.
  return transfersByAddress[address] ?? [];
}

// --- Live mode -------------------------------------------------------------

/**
 * Fetch every OUTGOING transfer for one address, following pagination.
 *
 * We query `fromAddress` only. The problem statement asks where the money went,
 * so we follow value forward from the reported wallet. (Querying `toAddress`
 * as well would let you find who funded the suspect - a useful Phase 5 feature
 * for identifying other victims, but out of scope here.)
 *
 * @param {string} address lowercase address
 * @param {object} [options]
 * @param {number} [options.maxTransfers] Stop after this many (across pages).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object[]>} raw Alchemy-shaped transfers
 */
async function fetchOutgoingTransfersLive(address, options = {}) {
  const maxTransfers = options.maxTransfers ?? config.maxTransfersPerAddress;

  /** @type {object[]} */
  const collected = [];
  let pageKey;
  let page = 0;

  // Bound the pagination loop independently of maxTransfers so a malformed
  // pageKey response can never spin forever.
  const MAX_PAGES = 20;

  do {
    const remaining = maxTransfers - collected.length;
    if (remaining <= 0) break;

    const pageSize = Math.min(remaining, ALCHEMY_MAX_PAGE_SIZE);

    /** Alchemy expects a single object parameter, and maxCount as hex. */
    const params = [
      {
        fromAddress: address,
        category: CATEGORIES,
        withMetadata: true, // gives us blockTimestamp inline - see parseTimestamp
        excludeZeroValue: true,
        order: 'desc', // newest first: recent movements matter most in live fraud
        maxCount: `0x${pageSize.toString(16)}`,
        ...(pageKey ? { pageKey } : {}),
      },
    ];

    const response = await rpcSend('alchemy_getAssetTransfers', params, {
      label: `getAssetTransfers(${address.slice(0, 10)}..., page ${page + 1})`,
      signal: options.signal,
    });

    const transfers = Array.isArray(response?.transfers) ? response.transfers : [];
    collected.push(...transfers);

    pageKey = response?.pageKey;
    page += 1;

    if (page >= MAX_PAGES && pageKey) {
      logger.warn('Stopped paginating at page cap; address is very high-volume', {
        address,
        pages: page,
        collected: collected.length,
      });
      break;
    }
  } while (pageKey && collected.length < maxTransfers);

  return collected;
}

// --- Public entry point ----------------------------------------------------

/**
 * Fetch and normalise all outgoing transfers for one address.
 *
 * Routes to the live or fixture backend based on `MOCK_MODE`, then applies the
 * shared normalisation and filtering pipeline. Callers receive clean canonical
 * `Transfer` objects and never see raw RPC output.
 *
 * @param {string} address Any casing; normalised internally.
 * @param {object} [options]
 * @param {number} [options.maxTransfers]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ transfers: Transfer[], rawCount: number, discarded: number }>}
 */
export async function fetchOutgoingTransfers(address, options = {}) {
  const normalized = normalizeAddress(address);

  const raw = config.mockMode
    ? await fetchOutgoingTransfersMock(normalized)
    : await fetchOutgoingTransfersLive(normalized, options);

  /** @type {Transfer[]} */
  const transfers = [];
  for (const entry of raw) {
    const normalizedTransfer = normalizeTransfer(entry);
    if (normalizedTransfer) transfers.push(normalizedTransfer);
  }

  return {
    transfers,
    rawCount: raw.length,
    discarded: raw.length - transfers.length,
  };
}

/** Exposed for the /health endpoint and for Phase 4's asset filter UI. */
export function describeTrackedAssets() {
  return {
    network: config.network,
    isKnownNetwork: assets.isKnownNetwork,
    categories: CATEGORIES,
    native: assets.native.symbol,
    tokens: assets.tokens.map((token) => token.symbol),
    thresholds: {
      native: config.minNativeValue,
      stablecoin: config.minStableValue,
    },
  };
}
