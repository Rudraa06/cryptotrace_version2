/**
 * services/multiChainTrace.service.js
 * ---------------------------------------------------------------------------
 * Cross-chain BFS re-trace, triggered when a bridge hop is detected in the
 * primary (Ethereum) trace.
 *
 * ---------------------------------------------------------------------------
 * SAME-ADDRESS ASSUMPTION — flagged explicitly
 * ---------------------------------------------------------------------------
 * After a bridge transfer, funds on the destination chain are assumed to land
 * at the SAME address as the sender on the source chain.  This holds for:
 *
 *   ✓ Polygon PoS Bridge — bridged tokens always land at the same address
 *   ✓ Wormhole Token Bridge — same address
 *   ✓ Hop Protocol — same address
 *   ✗ Bridges with explicit `recipient` params (e.g., bridgeToSpecificAddress)
 *   ✗ Bridges using intermediary escrow wallets
 *
 * Every cross-chain result is tagged `assumption: 'same-address'` so the
 * investigator always sees the caveat and knows to verify manually.
 *
 * ---------------------------------------------------------------------------
 * MOCK_MODE
 * ---------------------------------------------------------------------------
 * `getChainContext` returns null in MOCK_MODE, so `traceCrossChain` returns
 * an empty result with a warning immediately.  No network calls are made.
 */

import { normalizeTransfer }            from './assetTransfers.js';
import { fetchTransfersForChain,
         getChainContext }              from '../lib/chainProviders.js';
import { getExchangeInfo }              from '../config/knownExchanges.js';
import { lookupContract }               from '../data/knownContracts.js';
import { normalizeAddress, toChecksum } from '../lib/addresses.js';
import { settleWithConcurrency }        from '../lib/concurrency.js';
import { logger }                       from '../lib/logger.js';
import { config }                       from '../config/env.js';

// ---------------------------------------------------------------------------

/**
 * @typedef {object} CrossChainResult
 * @property {string}   chain           Destination chain slug, e.g. 'polygon-mainnet'.
 * @property {string}   assumption      Always 'same-address' — investigator must verify.
 * @property {object[]} wallets         Wallet nodes on the destination chain.
 * @property {object[]} transactions    Transfer edges on the destination chain.
 * @property {object[]} exchangesFound  Exchanges reached on the destination chain.
 * @property {string[]} warnings        Non-fatal issues encountered.
 * @property {{ address: string, chain: string, bridge: string }} bridgedFrom
 */

/**
 * Run a bounded BFS on a secondary chain starting from `address`.
 *
 * Conservative defaults:
 *   - depth is capped at `Math.min(depth, 2)` to limit secondary-chain RPC cost.
 *   - Any error in a single hop is caught and surfaced as a warning; it never
 *     aborts the other hops or the primary trace.
 *
 * @param {object}      opts
 * @param {string}      opts.address           Lowercase address to trace.
 * @param {string}      opts.destinationChain  Alchemy network slug.
 * @param {string}      opts.sourceChain       Where the bridge transfer originated.
 * @param {string}      opts.bridgeName        Human-readable bridge name for the record.
 * @param {number}      [opts.depth=2]         How many hops to follow on destination chain.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<CrossChainResult>}
 */
export async function traceCrossChain({
  address,
  destinationChain,
  sourceChain,
  bridgeName,
  depth = 2,
  signal,
}) {
  const ctx = getChainContext(destinationChain);

  if (!ctx) {
    return {
      chain:         destinationChain,
      assumption:    'same-address',
      wallets:       [],
      transactions:  [],
      exchangesFound: [],
      warnings: [
        `Cross-chain provider for ${destinationChain} is unavailable ` +
        `(MOCK_MODE or missing ALCHEMY_API_KEY). Trace manually at the destination.`,
      ],
      bridgedFrom: { address, chain: sourceChain, bridge: bridgeName },
    };
  }

  const root   = normalizeAddress(address);
  const warnings = [];

  logger.info('Cross-chain trace started', {
    address: root.slice(0, 10),
    sourceChain,
    destinationChain,
    depth,
  });

  // ── Traversal state ───────────────────────────────────────────────────────

  /** @type {Map<string, object>} wallet nodes on the destination chain */
  const wallets      = new Map();
  /** @type {Map<string, object>} transfer edges on the destination chain */
  const transactions = new Map();
  /** Cycle guard. */
  const seen         = new Set([root]);

  // Seed the root node — the cross-chain entry point.
  const rootExchange = getExchangeInfo(root);
  wallets.set(root, {
    address:        root,
    addressDisplay: toChecksum(root),
    hop:            0,
    chain:          destinationChain,
    isExchange:     Boolean(rootExchange),
    exchangeName:   rootExchange?.exchange ?? null,
    exchangeLabel:  rootExchange?.label    ?? null,
    contractTag:    lookupContract(root),
    inboundValue:   0,
    outboundValue:  0,
    inboundCount:   0,
    outboundCount:  0,
    expanded:       false,
    notExpandedReason: null,
    // Flag this node as the bridge entry point so the UI can annotate it.
    bridgeEntry:    true,
    bridgeName,
    bridgedFrom:    { address: root, chain: sourceChain },
  });

  const effectiveDepth = Math.min(depth, config.maxTraceDepth, 2); // hard cap at 2
  let frontier = [root];

  // ── BFS ───────────────────────────────────────────────────────────────────
  for (let hop = 0; hop < effectiveDepth; hop += 1) {
    if (frontier.length === 0 || signal?.aborted) break;

    const results = await settleWithConcurrency(
      frontier,
      config.rpcConcurrency,
      async (candidate) => {
        const raw = await fetchTransfersForChain(destinationChain, candidate, { signal });
        return { candidate, raw };
      }
    );

    const nextFrontier = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        warnings.push(
          `${destinationChain}: RPC failure at hop-${hop} — ` +
          (result.reason?.message ?? String(result.reason)).slice(0, 120)
        );
        continue;
      }

      const { candidate, raw } = result.value;
      const node = wallets.get(candidate);
      node.expanded = true;

      for (const rawTransfer of raw) {
        // Normalise using the destination chain's asset registry (different
        // contract addresses for USDT/USDC etc.).
        const assetEntry = ctx.assets.resolve(rawTransfer);
        if (!assetEntry) continue; // token not on destination-chain allowlist

        const t = normalizeTransfer(rawTransfer);
        if (!t) continue;
        if (transactions.has(t.uniqueId)) continue;

        transactions.set(t.uniqueId, { ...t, hop: hop + 1, chain: destinationChain });

        node.outboundValue += t.amount;
        node.outboundCount += 1;

        if (!wallets.has(t.to)) {
          const ex = getExchangeInfo(t.to);
          wallets.set(t.to, {
            address:        t.to,
            addressDisplay: toChecksum(t.to),
            hop:            hop + 1,
            chain:          destinationChain,
            isExchange:     Boolean(ex),
            exchangeName:   ex?.exchange ?? null,
            exchangeLabel:  ex?.label    ?? null,
            contractTag:    lookupContract(t.to),
            inboundValue:   0,
            outboundValue:  0,
            inboundCount:   0,
            outboundCount:  0,
            expanded:       false,
            notExpandedReason: null,
          });
        }

        const recipient = wallets.get(t.to);
        recipient.inboundValue += t.amount;
        recipient.inboundCount += 1;

        // Add to next frontier unless it is a known exchange (stop there)
        // or already seen (cycle guard).
        if (!seen.has(t.to) && !recipient.isExchange) {
          seen.add(t.to);
          nextFrontier.push(t.to);
        }
      }
    }

    frontier = nextFrontier;
  }

  // ── Assemble result ───────────────────────────────────────────────────────

  const walletList = [...wallets.values()];
  const txList     = [...transactions.values()].sort((a, b) => a.timestamp - b.timestamp);

  const exchangesFound = walletList
    .filter((w) => w.isExchange && w.address !== root)
    .map((w) => ({
      address:        w.address,
      addressDisplay: w.addressDisplay,
      exchange:       w.exchangeName,
      label:          w.exchangeLabel,
      hop:            w.hop,
      chain:          destinationChain,
      receivedValue:  Number(w.inboundValue.toFixed(6)),
      receivedCount:  w.inboundCount,
    }))
    .sort((a, b) => a.hop - b.hop || b.receivedValue - a.receivedValue);

  logger.info('Cross-chain trace complete', {
    destinationChain,
    wallets:         walletList.length,
    transactions:    txList.length,
    exchanges:       exchangesFound.length,
  });

  return {
    chain:          destinationChain,
    assumption:     'same-address',
    wallets:        walletList,
    transactions:   txList,
    exchangesFound,
    warnings,
    bridgedFrom:    { address: root, chain: sourceChain, bridge: bridgeName },
  };
}
