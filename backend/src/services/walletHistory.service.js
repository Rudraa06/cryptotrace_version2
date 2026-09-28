/**
 * services/walletHistory.service.js
 * ---------------------------------------------------------------------------
 * PHASE 1 CORE: `fetchWalletHistory(address, depth)`
 *
 * Walks outward from a victim-reported wallet, following the money, and returns
 * a flat transaction set plus a wallet inventory - the exact payload Phase 2's
 * `ingestToGraph()` will MERGE into Neo4j.
 *
 * ---------------------------------------------------------------------------
 * WHY BREADTH-FIRST AND NOT RECURSION
 * ---------------------------------------------------------------------------
 * The roadmap says "recursively fetches". Semantically that is what happens, but
 * the implementation is an explicit breadth-first queue, and the reason is worth
 * being able to defend:
 *
 *   1. CORRECT HOP NUMBERS. BFS reaches every address by its shortest route
 *      first. Depth-first can reach a wallet at hop 4 via one branch when a
 *      2-hop route exists, and then Phase 3's shortestPath contradicts the hop
 *      labels Phase 1 wrote. BFS makes the two agree by construction.
 *
 *   2. NO STACK OVERFLOW. Real fraud graphs contain long chains. Recursion over
 *      a 15-hop trace with fan-out 12 will blow the call stack; a queue will not.
 *
 *   3. CONCURRENCY. A BFS level is a natural batch, so a whole frontier can be
 *      fetched in parallel under one rate limiter. Recursion serialises.
 *
 *   4. TERMINATION. Cycles are endemic - launderers deliberately create them.
 *      A visited-set on a queue is trivially correct; the recursive equivalent
 *      needs the same set threaded through every call anyway.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR GUARD RAILS
 * ---------------------------------------------------------------------------
 * Unbounded graph expansion is the single biggest practical failure mode here,
 * so four independent brakes are applied:
 *
 *   - DEPTH CAP        (`depth`)                    how far we walk
 *   - FAN-OUT CAP      (`maxFanoutPerAddress`)      how many branches per wallet
 *   - GLOBAL CAP       (`maxAddressesPerTrace`)     total work circuit breaker
 *   - EXCHANGE CUT-OFF (`isKnownExchange`)          stop at the answer
 *
 * The exchange cut-off is the analytically important one. A Binance hot wallet
 * makes hundreds of thousands of outgoing transfers; following them would bury
 * the signal, exhaust the API quota, and produce a graph in which every wallet
 * appears connected to every other. When funds reach a CEX, the trail has
 * reached its destination.
 */

import { config } from '../config/env.js';
import { settleWithConcurrency } from '../lib/concurrency.js';
import { normalizeAddress, toChecksum } from '../lib/addresses.js';
import { logger } from '../lib/logger.js';
import { getExchangeInfo, isKnownExchange } from '../config/knownExchanges.js';
import { fetchOutgoingTransfers } from './assetTransfers.js';
import { lookupContract } from '../data/knownContracts.js';
import { resolveDexSwap } from './dexSwapResolver.service.js';
import { traceCrossChain } from './multiChainTrace.service.js';

/**
 * @typedef {object} WalletNode
 * @property {string} address        Lowercase - canonical key for Neo4j MERGE.
 * @property {string} addressDisplay EIP-55 checksummed, for the UI.
 * @property {number} hop            Shortest hop distance from the root.
 * @property {boolean} isExchange    Maps to the `isExchange` property in Neo4j.
 * @property {string|null} exchangeName
 * @property {string|null} exchangeLabel
 * @property {number} outboundValue  Summed outgoing amount we observed.
 * @property {number} inboundValue   Summed incoming amount we observed.
 * @property {number} outboundCount
 * @property {number} inboundCount
 * @property {boolean} expanded      Did we fetch this wallet's own transfers?
 * @property {string|null} notExpandedReason
 */

/**
 * Rough USD weighting used ONLY to rank branches for the fan-out cap.
 *
 * The problem: fan-out picks the "largest" outgoing branches, but amounts are
 * denominated in different assets. Ranking 0.4 ETH below 100 USDT by raw number
 * would be badly wrong - the ETH is worth roughly ten times more. Since we have
 * no price oracle in Phase 1, a single configurable constant for the native coin
 * is enough to get the ordering broadly right.
 *
 * This value NEVER appears in output amounts. It only decides which branches are
 * interesting enough to follow.
 *
 * @param {{ amount: number, assetClass: string }} transfer
 * @returns {number}
 */
function rankingWeight(transfer) {
  return transfer.assetClass === 'native'
    ? transfer.amount * config.nativeUsdHint
    : transfer.amount;
}

/** Create a fresh, empty wallet record. */
function makeWalletNode(address, hop) {
  const exchange = getExchangeInfo(address);
  // Tag DEX routers, cross-chain bridges, and OFAC-sanctioned mixer pools.
  // Checked once at node creation; null for ordinary wallet addresses.
  const contractTag = lookupContract(address);
  return {
    address,
    addressDisplay: toChecksum(address),
    hop,
    isExchange: Boolean(exchange),
    exchangeName: exchange?.exchange ?? null,
    exchangeLabel: exchange?.label ?? null,
    outboundValue: 0,
    inboundValue: 0,
    outboundCount: 0,
    inboundCount: 0,
    expanded: false,
    notExpandedReason: null,
    contractTag, // null | { type: 'dex'|'bridge'|'mixer', name, destinationChains? }
  };
}

/**
 * Trace outgoing value flow from `address` up to `depth` hops.
 *
 * @param {string} address Victim-reported wallet. Any casing.
 * @param {number} [depth] Hops to follow. Clamped to `MAX_TRACE_DEPTH`.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] Cancels an in-flight trace.
 * @returns {Promise<{
 *   root: string,
 *   rootDisplay: string,
 *   depth: number,
 *   wallets: WalletNode[],
 *   transactions: import('./assetTransfers.js').Transfer[],
 *   exchangesFound: Array<{ address: string, exchange: string, label: string, hop: number, receivedValue: number }>,
 *   unresolvedLeads: Array<{ address: string, hop: number, receivedValue: number, reason: string }>,
 *   stats: object,
 *   warnings: string[]
 * }>}
 */
export async function fetchWalletHistory(address, depth = config.defaultTraceDepth, options = {}) {
  const startedAt = Date.now();
  const { signal, onProgress } = options;

  // --- Validate and clamp inputs ------------------------------------------
  const root = normalizeAddress(address); // throws InvalidAddressError -> HTTP 400

  const requestedDepth = Number.isFinite(depth) ? Math.floor(depth) : config.defaultTraceDepth;
  const effectiveDepth = Math.max(1, Math.min(requestedDepth, config.maxTraceDepth));

  /** @type {string[]} Non-fatal notes surfaced to the caller and the UI. */
  const warnings = [];

  if (requestedDepth !== effectiveDepth) {
    warnings.push(
      `Requested depth ${requestedDepth} was clamped to ${effectiveDepth} ` +
        `(server limit MAX_TRACE_DEPTH=${config.maxTraceDepth}).`
    );
  }

  // --- Traversal state -----------------------------------------------------

  /** @type {Map<string, WalletNode>} every wallet we have seen, by lowercase address */
  const wallets = new Map();

  /** @type {Map<string, import('./assetTransfers.js').Transfer>} deduped edges */
  const transactions = new Map();

  /** Addresses already queued or processed - the cycle guard. */
  const seen = new Set([root]);

  wallets.set(root, makeWalletNode(root, 0));

  const stats = {
    rpcCalls: 0,
    rpcFailures: 0,
    addressesExpanded: 0,
    rawTransfersSeen: 0,
    transfersDiscarded: 0,
    duplicateEdgesSkipped: 0,
    branchesSkippedByFanoutCap: 0,
    hopsCompleted: 0,
    truncatedByGlobalCap: false,
    swapsDetected: 0,
    swapsResolved: 0,
    swapsFlaggedForReview: 0,
  };

  /** Current BFS frontier. */
  let frontier = [root];

  // --- Breadth-first expansion, one hop per iteration ----------------------
  for (let hop = 0; hop < effectiveDepth; hop += 1) {
    if (frontier.length === 0) break;
    if (signal?.aborted) {
      warnings.push(`Trace cancelled by caller after hop ${hop}.`);
      break;
    }

    // Decide which frontier members to expand, and record why we skip the rest.
    const expandable = [];
    for (const candidate of frontier) {
      const node = wallets.get(candidate);

      // GUARD RAIL 4: an exchange is the destination, not a waypoint.
      // The root itself is exempt: if a victim reports an exchange address we
      // should still show what it did, and say so.
      if (candidate !== root && isKnownExchange(candidate)) {
        node.notExpandedReason = 'known-exchange-terminal';
        continue;
      }

      // GUARD RAIL 3: global circuit breaker.
      if (stats.addressesExpanded + expandable.length >= config.maxAddressesPerTrace) {
        node.notExpandedReason = 'global-address-cap';
        stats.truncatedByGlobalCap = true;
        continue;
      }

      expandable.push(candidate);
    }

    if (expandable.length === 0) {
      logger.info('Frontier exhausted', { hop, reason: 'nothing expandable' });
      break;
    }

    logger.info('Expanding BFS frontier', { hop, addresses: expandable.length });
    if (onProgress) {
      onProgress({ hop, addresses: expandable.length, completed: 0 });
    }

    let completedAddresses = 0;
    const totalAddresses = expandable.length;

    // Fetch the whole frontier in parallel, bounded by the RPC concurrency cap.
    // `settleWithConcurrency` means one bad address cannot sink the trace: a
    // partial graph is still useful evidence, an exception is not.
    const results = await settleWithConcurrency(
      expandable,
      config.rpcConcurrency,
      async (candidate) => {
        const result = await fetchOutgoingTransfers(candidate, { signal });
        completedAddresses += 1;
        if (typeof onProgress === 'function') {
          onProgress({ hop, addresses: totalAddresses, completed: completedAddresses });
        }
        return { candidate, ...result };
      }
    );

    /** Addresses discovered at hop+1, to become the next frontier. */
    const nextFrontier = [];

    for (const result of results) {
      stats.rpcCalls += 1;

      if (result.status === 'rejected') {
        stats.rpcFailures += 1;
        const reason = result.reason?.message ?? String(result.reason);
        logger.warn('Failed to fetch transfers for address; continuing', {
          hop,
          reason: reason.slice(0, 200),
        });
        warnings.push(`Could not fetch transfers for one hop-${hop} wallet: ${reason.slice(0, 120)}`);
        continue;
      }

      const { candidate, transfers, rawCount, discarded } = result.value;

      const node = wallets.get(candidate);
      node.expanded = true;
      stats.addressesExpanded += 1;
      stats.rawTransfersSeen += rawCount;
      stats.transfersDiscarded += discarded;

      // --- Record every surviving transfer as a graph edge ------------------
      // Note we keep ALL of them, even branches the fan-out cap declines to
      // follow. The evidence is cheap to store and valuable to show; it is only
      // further *expansion* that is expensive.
      for (const transfer of transfers) {
        // Dedupe on `uniqueId`, not `hash`.
        //
        // SCHEMA NOTE FOR PHASE 2: your Neo4j spec makes TRANSACTION.hash
        // unique. That is not quite safe - one transaction can contain several
        // transfers (a contract paying out to five wallets shares one hash), and
        // a uniqueness constraint on `hash` would silently drop four of the five
        // edges. Recommendation: keep `hash` as an indexed property but make
        // `uniqueId` the unique key. Flagging it here so it is a deliberate
        // decision in Phase 2 rather than a mystery later.
        if (transactions.has(transfer.uniqueId)) {
          stats.duplicateEdgesSkipped += 1;
          continue;
        }

        transactions.set(transfer.uniqueId, { ...transfer, hop: hop + 1 });

        // Running volume totals, used for node sizing in the Phase 4 graph.
        node.outboundValue += transfer.amount;
        node.outboundCount += 1;

        // Make sure the recipient exists as a node even if we never expand it.
        if (!wallets.has(transfer.to)) {
          wallets.set(transfer.to, makeWalletNode(transfer.to, hop + 1));
        }
        const recipient = wallets.get(transfer.to);
        recipient.inboundValue += transfer.amount;
        recipient.inboundCount += 1;

        // ── DEX swap continuation ───────────────────────────────────────────
        // If this transfer landed on a known DEX router, attempt to resolve
        // the token-out leg so BFS can trace beyond the swap.
        //
        // IMPORTANT: this must run BEFORE the fan-out cap so that the swap
        // output address is pushed onto nextFrontier via the seen-set, not
        // via the fan-out ranking. The router itself will not appear in
        // `byRecipient` rankings — we skip expanding it below.
        if (recipient.contractTag?.type === 'dex') {
          stats.swapsDetected += 1;

          // resolveDexSwap never throws — returns a status object on any failure.
          const resolution = await resolveDexSwap(transfer, transfer.to, hop + 1, signal);

          // Persist the swap event on the router node for the frontend.
          recipient.swapEvent = {
            status:       resolution.status,
            fromToken:    resolution.fromToken,
            toToken:      resolution.toToken ?? null,
            toAddress:    resolution.toAddress ?? null,
            toAmount:     resolution.toAmount ?? null,
            viaContract:  resolution.viaContract,
            txHash:       resolution.txHash,
            swappedAtHop: resolution.swappedAtHop,
            reason:       resolution.reason ?? null,
          };

          if (resolution.status === 'resolved' && resolution.transfer && resolution.toAddress) {
            stats.swapsResolved += 1;

            // Inject the output transfer as a graph edge: router → outputRecipient.
            const outTransfer = resolution.transfer;
            if (!transactions.has(outTransfer.uniqueId)) {
              transactions.set(outTransfer.uniqueId, {
                ...outTransfer,
                hop: hop + 2,
                swapOutput: true, // annotate so graph.service can style this edge
              });
            }

            // Ensure the output recipient node exists in the wallet map.
            if (!wallets.has(resolution.toAddress)) {
              wallets.set(resolution.toAddress, makeWalletNode(resolution.toAddress, hop + 2));
            }
            const swapOutputNode = wallets.get(resolution.toAddress);
            swapOutputNode.inboundValue += resolution.toAmount ?? 0;
            swapOutputNode.inboundCount += 1;

            // Push the output address onto the next BFS frontier.
            // hop + 2 because: sender(hop) → router(hop+1) → outputRecipient(hop+2).
            if (!seen.has(resolution.toAddress)) {
              seen.add(resolution.toAddress);
              nextFrontier.push(resolution.toAddress);
              logger.info('DEX swap: BFS continuing beyond router', {
                fromToken: resolution.fromToken,
                toToken:   resolution.toToken,
                toAddress: resolution.toAddress,
                hop:       hop + 2,
              });
            }
          } else {
            // Swap detected but output could not be resolved cleanly.
            stats.swapsFlaggedForReview += 1;
            recipient.notExpandedReason = 'swap-detected-manual-review';
            warnings.push(
              `Swap via ${recipient.contractTag.name} at hop ${hop + 1} ` +
              `(tx ${transfer.hash.slice(0, 10)}...): ${resolution.reason ?? resolution.status}. ` +
              'Added to unresolvedLeads for manual investigation.'
            );
          }
        }

        // ── Bridge cross-chain continuation ─────────────────────────────────────
        // When a transfer lands on a known bridge, record the pending cross-chain
        // trace so we can run it after the main BFS loop completes.
        // Only active when MULTI_CHAIN_ENABLED=true.
        //
        // We do NOT expand the bridge contract via normal BFS: its outgoing
        // transfers are internal liquidity mechanics, not the user's fund flow.
        if (
          config.multiChainEnabled &&
          recipient.contractTag?.type === 'bridge' &&
          Array.isArray(recipient.contractTag.destinationChains)
        ) {
          // Same-address assumption: bridged funds land at the sender's address
          // on the destination chain.  Flagged in the result for manual verification.
          recipient.pendingCrossChainTraces = recipient.contractTag.destinationChains.map((chain) => ({
            destinationChain: chain,
            address:          transfer.from, // the wallet that initiated the bridge transfer
            bridgeName:       recipient.contractTag.name,
          }));
          recipient.notExpandedReason = 'bridge-cross-chain';

          logger.info('Bridge detected: cross-chain trace scheduled', {
            bridge:            recipient.contractTag.name,
            destinationChains: recipient.contractTag.destinationChains,
            address:           transfer.from.slice(0, 10),
          });
        }
      }

      // --- GUARD RAIL 2: fan-out cap ---------------------------------------
      // Aggregate by recipient first, then keep the largest N. Aggregating
      // before ranking matters: a peeling chain often sends to one address in
      // many small slices precisely to look unimportant. Summed, it ranks
      // correctly; ranked per-transfer, it would be discarded.
      const byRecipient = new Map();
      for (const transfer of transfers) {
        const current = byRecipient.get(transfer.to) ?? 0;
        byRecipient.set(transfer.to, current + rankingWeight(transfer));
      }

      const rankedRecipients = [...byRecipient.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([recipientAddress]) => recipientAddress);

      const followed = rankedRecipients.slice(0, config.maxFanoutPerAddress);
      const dropped = rankedRecipients.length - followed.length;

      if (dropped > 0) {
        stats.branchesSkippedByFanoutCap += dropped;
        const skippedNote = `hop-${hop} wallet had ${rankedRecipients.length} recipients; followed the largest ${followed.length}.`;
        if (!warnings.includes(skippedNote)) warnings.push(skippedNote);
      }

      for (const recipientAddress of followed) {
        if (seen.has(recipientAddress)) continue; // cycle guard
        seen.add(recipientAddress);
        nextFrontier.push(recipientAddress);
      }
    }

    // GUARD RAIL 5: Hard Circuit Breakers
    if (stats.truncatedByGlobalCap) {
      warnings.push(`Global address cap (${config.maxAddressesPerTrace}) reached. Halting BFS completely to prevent runaway execution.`);
      logger.warn('Trace aborted by global circuit breaker', { hop });
      break;
    }

    if (stats.rpcCalls > 20 && (stats.rpcFailures / stats.rpcCalls) > 0.2) {
      warnings.push(`Trace aborted: high RPC failure rate (${stats.rpcFailures}/${stats.rpcCalls}).`);
      logger.error('Trace aborted by RPC failure circuit breaker', { hop, rpcCalls: stats.rpcCalls, rpcFailures: stats.rpcFailures });
      break;
    }

    stats.hopsCompleted = hop + 1;
    frontier = nextFrontier;
  }

  // --- Explain every unexpanded wallet -------------------------------------
  //
  // Why this pass exists: the BFS loop only labels wallets it actually
  // considered. A wallet sitting at exactly `depth` hops is never part of a
  // processed frontier, so it would leave the traversal with
  // `notExpandedReason: null` - indistinguishable from a wallet we stopped at
  // because it was an exchange.
  //
  // That distinction is the whole product. "The trail ends here because this is
  // a Binance hot wallet" is an answer; "the trail ends here because you asked
  // for 3 hops" is a prompt to search deeper. Phase 4's sidebar renders these
  // very differently, so the backend must state which one it is.
  for (const node of wallets.values()) {
    if (node.expanded || node.notExpandedReason) continue;

    if (node.isExchange && node.address !== root) {
      // The answer: funds reached an identified cash-out point.
      node.notExpandedReason = 'known-exchange-terminal';
    } else if (!seen.has(node.address)) {
      // Discovered as a recipient, but its branch lost the fan-out ranking.
      node.notExpandedReason = 'not-selected-by-fanout-cap';
    } else if (node.hop >= effectiveDepth) {
      // Frontier at the depth boundary: more graph exists beyond this point.
      node.notExpandedReason = 'depth-limit-reached';
    } else if (stats.truncatedByGlobalCap) {
      node.notExpandedReason = 'global-address-cap';
    } else {
      node.notExpandedReason = 'not-expanded';
    }
  }

  // --- Assemble the result -------------------------------------------------

  const walletList = [...wallets.values()];
  const transactionList = [...transactions.values()].sort((a, b) => a.timestamp - b.timestamp);

  /**
   * Frontier wallets where the trail was cut short by a limit rather than by
   * reaching an exchange. Surfaced explicitly because it is the actionable
   * signal for the operator: these are the leads still worth pulling.
   */
  const unresolvedLeads = walletList
    .filter(
      (node) =>
        !node.isExchange &&
        (node.notExpandedReason === 'depth-limit-reached' ||
          node.notExpandedReason === 'not-selected-by-fanout-cap' ||
          node.notExpandedReason === 'global-address-cap')
    )
    .sort((a, b) => b.inboundValue - a.inboundValue)
    .slice(0, 25)
    .map((node) => ({
      address:        node.address,
      addressDisplay: node.addressDisplay,
      hop:            node.hop,
      receivedValue:  Number(node.inboundValue.toFixed(6)),
      reason:         node.notExpandedReason,
      // Surface swap metadata so the UI can display "swapped ETH→USDC via Uniswap"
      // even for routers where the output could not be automatically followed.
      swapEvent:      node.swapEvent ?? null,
    }));

  /**
   * Exchanges reached, shallowest first. This is the headline answer to the
   * problem statement, so it is surfaced explicitly rather than left for the
   * caller to derive.
   */
  const exchangesFound = walletList
    .filter((wallet) => wallet.isExchange && wallet.address !== root)
    .map((wallet) => ({
      address: wallet.address,
      addressDisplay: wallet.addressDisplay,
      exchange: wallet.exchangeName,
      label: wallet.exchangeLabel,
      hop: wallet.hop,
      receivedValue: Number(wallet.inboundValue.toFixed(6)),
      receivedCount: wallet.inboundCount,
    }))
    .sort((a, b) => a.hop - b.hop || b.receivedValue - a.receivedValue);

  if (transactionList.length === 0) {
    warnings.push(
      'No outgoing transfers found for this wallet within the tracked asset set. ' +
        'The address may be freshly created, inbound-only, or hold assets we do not track.'
    );
  }

  if (exchangesFound.length === 0 && transactionList.length > 0) {
    warnings.push(
      `No known exchange reached within ${effectiveDepth} hop(s). Try a greater depth, ` +
        'or extend the registry in src/config/knownExchanges.js.'
    );
  }

  // --- Cross-chain traces (MULTI_CHAIN_ENABLED only) ----------------------
  //
  // After the main BFS is complete, run secondary-chain traces for every bridge
  // node that was detected above.  These are intentionally sequential (not
  // parallel with the main trace) so the primary result is always returned even
  // if every cross-chain call fails.

  /** @type {import('./multiChainTrace.service.js').CrossChainResult[]} */
  const crossChainResults = [];

  if (config.multiChainEnabled && !signal?.aborted) {
    const bridgeNodes = [...wallets.values()].filter(
      (n) => Array.isArray(n.pendingCrossChainTraces) && n.pendingCrossChainTraces.length > 0
    );

    for (const bridgeNode of bridgeNodes) {
      for (const pending of bridgeNode.pendingCrossChainTraces) {
        try {
          const ccResult = await traceCrossChain({
            address:          pending.address,
            destinationChain: pending.destinationChain,
            sourceChain:      config.network,
            bridgeName:       pending.bridgeName,
            depth:            Math.min(2, effectiveDepth), // conservative cap on secondary chains
            signal,
          });
          crossChainResults.push(ccResult);
          for (const w of ccResult.warnings) warnings.push(w);
          stats.crossChainTracesRun = (stats.crossChainTracesRun ?? 0) + 1;
        } catch (err) {
          warnings.push(
            `Cross-chain trace to ${pending.destinationChain} failed: ` +
            (err?.message?.slice(0, 120) ?? 'unknown error')
          );
        }
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  logger.info('Trace complete', {
    root: toChecksum(root),
    depth: effectiveDepth,
    wallets: walletList.length,
    transactions: transactionList.length,
    exchanges: exchangesFound.length,
    rpcCalls: stats.rpcCalls,
    crossChainTraces: crossChainResults.length,
    durationMs,
  });

  return {
    root,
    rootDisplay: toChecksum(root),
    depth: effectiveDepth,
    wallets: walletList,
    transactions: transactionList,
    exchangesFound,
    unresolvedLeads,
    stats: { ...stats, durationMs, mockMode: config.mockMode, network: config.network },
    warnings,
    crossChain: crossChainResults,  // [] when MULTI_CHAIN_ENABLED=false
  };
}
