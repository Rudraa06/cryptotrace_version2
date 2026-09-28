/**
 * services/dexSwapResolver.service.js
 * ---------------------------------------------------------------------------
 * Given a transfer that landed on a DEX router, resolves the corresponding
 * "token out" leg of the swap so the BFS can continue tracing beyond the DEX.
 *
 * ---------------------------------------------------------------------------
 * STRATEGY
 * ---------------------------------------------------------------------------
 * A DEX swap is a single Ethereum transaction that contains two asset transfer
 * events:
 *   (1) token-in:  originalSender → router      (the inbound we already have)
 *   (2) token-out: router         → recipient    (what we need to find)
 *
 * Both legs share the same tx hash. We fetch all transfers FROM the router
 * that land within the same block (efficient: one RPC call, narrow block range),
 * then filter by tx hash to isolate the output legs.
 *
 * ---------------------------------------------------------------------------
 * MOCK_MODE
 * ---------------------------------------------------------------------------
 * Returns a 'mock-mode' resolution immediately — no network calls are made.
 * The BFS falls back to treating the router as a terminal node.
 *
 * ---------------------------------------------------------------------------
 * EDGE CASES
 * ---------------------------------------------------------------------------
 * Case 1 — Exactly one output transfer in same tx → clean resolution.
 *
 * Case 2 — Multiple output transfers (multi-hop swap, e.g. ETH→USDC→DAI):
 *   Try a secondary filter: find the output whose `to` matches the original
 *   sender. If exactly one matches → resolved. Otherwise → ambiguous.
 *
 * Case 3 — No output found on the tracked allowlist:
 *   The swap produced a token we don't track (governance token, NFT, etc.).
 *   Return 'no-output-found'. BFS stops at the router.
 *
 * Case 4 — RPC call fails:
 *   Caught, logged, returned as 'rpc-error'. Never throws. BFS continues on
 *   other branches.
 */

import { config } from '../config/env.js';
import { rpcSend } from './provider.js';
import { normalizeTransfer } from './assetTransfers.js';
import { normalizeAddressOrNull } from '../lib/addresses.js';
import { logger } from '../lib/logger.js';

/**
 * @typedef {object} SwapResolution
 * @property {'resolved'|'ambiguous'|'no-output-found'|'mock-mode'|'rpc-error'} status
 * @property {string}        fromToken      Symbol of the token going IN to the swap.
 * @property {string}       [toToken]       Symbol of the token coming OUT (if resolved).
 * @property {string}       [toAddress]     Lowercase address that received the output.
 * @property {number}       [toAmount]      Amount received.
 * @property {string}        viaContract    Lowercase router address.
 * @property {string}        txHash         The transaction hash being inspected.
 * @property {number}        swappedAtHop   BFS hop number where the swap was detected.
 * @property {string}       [reason]        Human-readable explanation for non-resolved statuses.
 * @property {import('./assetTransfers.js').Transfer} [transfer]  The canonical Transfer object for the output leg.
 */

/**
 * Attempt to resolve the output leg of a DEX swap.
 *
 * @param {import('./assetTransfers.js').Transfer} inboundTransfer
 *   The canonical Transfer whose `to` is a DEX router address.
 * @param {string} routerAddress  Lowercase router address (= inboundTransfer.to).
 * @param {number} hop            Current BFS hop number, stored in the result record.
 * @param {AbortSignal} [signal]
 * @returns {Promise<SwapResolution>}
 */
export async function resolveDexSwap(inboundTransfer, routerAddress, hop, signal) {
  /** Common fields shared by every resolution variant. */
  const base = {
    fromToken:    inboundTransfer.asset,
    viaContract:  routerAddress,
    txHash:       inboundTransfer.hash,
    swappedAtHop: hop,
  };

  // ── MOCK_MODE: no network access ────────────────────────────────────────
  if (config.mockMode) {
    return {
      ...base,
      status: 'mock-mode',
      reason: 'Swap resolution skipped in MOCK_MODE — no network access.',
    };
  }

  // ── Guard: need a block number to scope the query ────────────────────────
  const blockNum = inboundTransfer.blockNumber;
  if (!blockNum) {
    return {
      ...base,
      status: 'no-output-found',
      reason: 'Inbound transfer missing blockNumber; cannot scope swap resolution query.',
    };
  }

  const blockHex = `0x${blockNum.toString(16)}`;

  try {
    // Fetch all transfers FROM the router within the same block.
    //
    // WHY block-scoped and not eth_getTransactionReceipt?
    // eth_getTransactionReceipt gives raw logs that require per-contract ABI
    // decoding. alchemy_getAssetTransfers already returns normalised amounts
    // with symbols. Scoping to one block makes the result set tiny (~64 rows
    // max from a busy router in one block) and avoids scanning its full history.
    const params = [
      {
        fromAddress:      routerAddress,
        fromBlock:        blockHex,
        toBlock:          blockHex,
        category:         ['external', 'erc20', 'internal'],
        withMetadata:     true,
        excludeZeroValue: true,
        maxCount:         '0x40', // 64 — ample for one block from one router
      },
    ];

    const response = await rpcSend('alchemy_getAssetTransfers', params, {
      label: `dexSwapResolver(${inboundTransfer.hash.slice(0, 10)}...)`,
      signal,
    });

    const rawTransfers = Array.isArray(response?.transfers) ? response.transfers : [];

    // ── Filter to transfers sharing the same tx hash ─────────────────────
    // Among all the router's transfers in this block, only those with the same
    // hash belong to our specific swap.
    const sameTxRaw = rawTransfers.filter(
      (t) => typeof t.hash === 'string' && t.hash.toLowerCase() === inboundTransfer.hash
    );

    if (sameTxRaw.length === 0) {
      logger.debug('dexSwapResolver: no outbound transfers in same tx', {
        hash:   inboundTransfer.hash,
        router: routerAddress,
        block:  blockNum,
      });
      return {
        ...base,
        status: 'no-output-found',
        reason: 'No outgoing transfer from router found within the same transaction.',
      };
    }

    // Normalise through the standard pipeline: allowlist, dust threshold, etc.
    const normalised = sameTxRaw.map(normalizeTransfer).filter(Boolean);

    if (normalised.length === 0) {
      return {
        ...base,
        status: 'no-output-found',
        reason:
          'Swap output token is not on the tracked allowlist (ETH/USDT/USDC/DAI/WBTC). ' +
          'The swap may have produced a governance token, LP token, or NFT.',
      };
    }

    // ── Case 1: Exactly one output transfer → clean resolution ───────────
    if (normalised.length === 1) {
      const out = normalised[0];
      logger.info('dexSwapResolver: swap resolved (single output)', {
        hash:      inboundTransfer.hash,
        fromToken: inboundTransfer.asset,
        toToken:   out.asset,
        toAddress: out.to,
        amount:    out.amount,
      });
      return {
        ...base,
        status:    'resolved',
        toToken:   out.asset,
        toAddress: out.to,
        toAmount:  out.amount,
        transfer:  out,
      };
    }

    // ── Case 2: Multiple outputs → try sender-match heuristic ────────────
    // Common pattern: ETH → USDC → DAI produces two internal transfer events
    // but only ONE final output goes back to the original user.
    const originalSender = inboundTransfer.from;
    const backToSender = normalised.filter(
      (t) => normalizeAddressOrNull(t.to) === originalSender
    );

    if (backToSender.length === 1) {
      const out = backToSender[0];
      logger.info('dexSwapResolver: swap resolved (multi-hop, sender-match)', {
        hash:         inboundTransfer.hash,
        totalOutputs: normalised.length,
        fromToken:    inboundTransfer.asset,
        toToken:      out.asset,
        toAddress:    out.to,
      });
      return {
        ...base,
        status:    'resolved',
        toToken:   out.asset,
        toAddress: out.to,
        toAmount:  out.amount,
        transfer:  out,
      };
    }

    // ── Case 3: Still ambiguous — flag for manual review ─────────────────
    // This occurs when:
    //   - The swap output went to a DIFFERENT address than the sender
    //     (swapExactTokensForTokens with a custom recipient param)
    //   - Multiple outputs go to multiple different addresses (split routes)
    logger.warn('dexSwapResolver: ambiguous swap output', {
      hash:            inboundTransfer.hash,
      outputCount:     normalised.length,
      outputTokens:    normalised.map((t) => t.asset),
      outputAddresses: normalised.map((t) => t.to),
    });
    return {
      ...base,
      status: 'ambiguous',
      reason:
        `Swap produced ${normalised.length} output transfer(s) with distinct recipients ` +
        `(tokens: ${normalised.map((t) => t.asset).join(', ')}). ` +
        'Cannot safely identify the correct continuation — the output recipient may differ ' +
        'from the original sender. Flagged for manual review.',
    };
  } catch (error) {
    logger.warn('dexSwapResolver: RPC call failed', {
      hash:   inboundTransfer.hash,
      router: routerAddress,
      reason: error?.message?.slice(0, 200),
    });
    return {
      ...base,
      status: 'rpc-error',
      reason: `Swap resolution RPC call failed: ${error?.message?.slice(0, 120) ?? 'unknown error'}`,
    };
  }
}
