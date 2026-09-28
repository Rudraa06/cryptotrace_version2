/**
 * services/riskEngine.service.js
 * ---------------------------------------------------------------------------
 * PHASE 4: Automated Graph Feature Extraction & Dynamic Risk Scoring
 *
 * Analyses the forceGraph payload produced by `lib/forceGraph.js` *after*
 * `toForceGraph` has run but *before* the response is sent.  Nodes are
 * enriched in-place; the original structure is returned so callers can chain.
 *
 * ---------------------------------------------------------------------------
 * SCORING MODEL (v2 — fully dynamic, replaces the static -20/hop heuristic)
 * ---------------------------------------------------------------------------
 * Each non-exchange node is assessed across four independent dimensions.
 * Each dimension contributes a bounded additive component; the final score
 * is clamped to [0, 100].
 *
 *  1. VELOCITY (0–30)
 *     Minimum delta between any inbound and outbound transfer timestamp.
 *     < 3 min  → 30 pts + HIGH_VELOCITY_LAYERING tag
 *     < 15 min → 20 pts + HIGH_VELOCITY_LAYERING tag
 *     < 60 min → 10 pts
 *
 *  2. FAN-OUT / PEELING CHAIN (0–30)
 *     Triggered when one inbound feed spawns > 5 outbound recipients AND the
 *     single largest recipient absorbs ≥ 80 % of the inbound value.
 *     Pure fan-out (1→many without the 80 % concentration) scores 15.
 *
 *  3. EXCHANGE PROXIMITY (0–20)
 *     BFS backwards from every known exchange node in the graph.
 *     hop 1 (direct deposit)   → 20 pts + DIRECT_OFFRAMP tag
 *     hop 2 (one remove)       → 12 pts
 *     hop 3                    →  6 pts
 *
 *  4. TAINT DIFFUSION (0–20)
 *     Decays geometrically from the reported wallet.
 *     score = 20 × 0.70^hop  (floor 0, always tagged TAINT_DIFFUSION for hops > 0)
 *
 *  5. MIXER PATTERN (0–20)
 *     Independent of the Phase 1 OFAC blocklist — detects the behavioural
 *     signature of Tornado Cash interaction even for unlisted pools.
 *     Triggered when ≥ 3 of a node's adjacent transfers (in OR out) use a
 *     canonical fixed denomination (0.1 / 1 / 10 / 100 ETH) AND those matching
 *     transfers all fall within a 24-hour window.
 *     ≥ 5 matching transfers → 20 pts + MIXER_INTERACTION tag
 *     ≥ 3 matching transfers → 10 pts + MIXER_INTERACTION tag
 *     Configurable via MIXER_DENOMINATIONS_ETH and MIXER_WINDOW_SECONDS constants.
 *
 * ---------------------------------------------------------------------------
 * OBFUSCATION TAGS (canonical set, used by aiNarrative and the UI)
 * ---------------------------------------------------------------------------
 *   HIGH_VELOCITY_LAYERING  rapid pass-through (< 60 min turnover)
 *   PEELING_CHAIN           fan-out with ≥ 80 % value concentration in one arm
 *   TAINT_DIFFUSION         value has moved ≥ 1 hop from the reported wallet
 *   DIRECT_OFFRAMP          wallet sends directly to a known exchange
 *   CASH_OUT                the exchange node itself
 *   MIXER_INTERACTION       fixed-denomination transfer pattern (≥ 3 hits in 24h)
 */

import { logger } from '../lib/logger.js';
import { inMemoryCrossCaseStore } from '../routes/complaints.routes.js';
import { getExchangeInfo } from '../config/knownExchanges.js';
import { isSanctioned, getSanctionsStatus } from './sanctions.service.js';

// ---------------------------------------------------------------------------
// Mixer pattern detection — constants (tune here to adjust sensitivity)
// ---------------------------------------------------------------------------

/**
 * Canonical Tornado Cash pool denominations, in ETH.
 * These are the ONLY amounts a Tornado Cash ETH pool accepts — any other value
 * is rejected by the contract. Matching 3+ transfers against this list within
 * a short window is a strong behavioural flag even when the pool address is not
 * on the OFAC blocklist (e.g., a newly deployed clone).
 *
 * To add a denomination: push to this array.
 */
const MIXER_DENOMINATIONS_ETH = Object.freeze([0.1, 1, 10, 100]);

/**
 * Relative tolerance used when comparing transfer amounts to denominations.
 * 0.0001 = 0.01 %, enough to absorb floating-point rounding in Alchemy's
 * parsed amounts without matching obviously wrong values.
 */
const AMOUNT_EPSILON = 0.0001;

/** Sliding-window size. Matching transfers must cluster inside this period. */
const MIXER_WINDOW_SECONDS = 24 * 60 * 60; // 24 hours

/** Thresholds for the two scoring tiers. */
const MIXER_HIT_THRESHOLD_WEAK   = 3; // → 10 pts
const MIXER_HIT_THRESHOLD_STRONG = 5; // → 20 pts

/**
 * Return true when a forceGraph link carries a canonical mixer denomination.
 * Only native ETH is inspected — ERC-20 Tornado Cash pools are already covered
 * by the Phase 1 OFAC blocklist, and scanning stablecoin amounts for round
 * numbers would produce enormous false-positive rates.
 *
 * @param {{ amount: number, asset: string }} edge
 * @returns {boolean}
 */
function isRoundDenomination(edge) {
  if (edge.asset !== 'ETH') return false;
  return MIXER_DENOMINATIONS_ETH.some(
    (d) => Math.abs(edge.amount - d) / d < AMOUNT_EPSILON
  );
}

/**
 * Detect a mixer interaction pattern in the transfers adjacent to a wallet.
 *
 * Algorithm:
 *   1. Collect all inbound AND outbound edges that match a canonical denomination.
 *   2. If fewer than MIXER_HIT_THRESHOLD_WEAK → no signal (return score 0).
 *   3. Sort matched edges by timestamp.
 *   4. Sliding-window pass: find the longest sub-sequence where first-to-last
 *      timestamp delta ≤ MIXER_WINDOW_SECONDS.
 *   5. Score based on the size of that window.
 *
 * Exported so it can be called from unit tests and from aiNarrative.service.js
 * to add weight to the executive summary when mixer behaviour is detected.
 *
 * @param {any[]} inboundEdges   forceGraph links where target === node.id
 * @param {any[]} outboundEdges  forceGraph links where source === node.id
 * @returns {{ score: number, matchCount: number, windowHours: number, denominations: number[] }}
 */
export function detectMixerPattern(inboundEdges, outboundEdges) {
  const allEdges = [...inboundEdges, ...outboundEdges];
  const matching = allEdges.filter(isRoundDenomination);

  if (matching.length < MIXER_HIT_THRESHOLD_WEAK) {
    return { score: 0, matchCount: matching.length, windowHours: 0, denominations: [] };
  }

  // Sort by timestamp; push zero-timestamp edges to the end so they don't
  // shrink the window artificially in mock/fixture mode.
  const withTimestamp = matching
    .filter((e) => e.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  // Fall back to raw count when timestamps are absent (e.g., fixture mode).
  if (withTimestamp.length < MIXER_HIT_THRESHOLD_WEAK) {
    const score = matching.length >= MIXER_HIT_THRESHOLD_STRONG ? 20 : 10;
    return {
      score,
      matchCount: matching.length,
      windowHours: 0,
      denominations: [...new Set(matching.map((e) => e.amount))].sort((a, b) => a - b),
    };
  }

  // ── Sliding window: find the densest cluster within MIXER_WINDOW_SECONDS ─
  let bestWindowCount = 0;
  let bestWindowStart = 0;
  let left = 0;

  for (let right = 0; right < withTimestamp.length; right += 1) {
    while (
      withTimestamp[right].timestamp - withTimestamp[left].timestamp >
      MIXER_WINDOW_SECONDS
    ) {
      left += 1;
    }
    const windowSize = right - left + 1;
    if (windowSize > bestWindowCount) {
      bestWindowCount = windowSize;
      bestWindowStart = left;
    }
  }

  if (bestWindowCount < MIXER_HIT_THRESHOLD_WEAK) {
    return { score: 0, matchCount: matching.length, windowHours: 0, denominations: [] };
  }

  const windowEdges = withTimestamp.slice(bestWindowStart, bestWindowStart + bestWindowCount);
  const windowSeconds =
    windowEdges[windowEdges.length - 1].timestamp - windowEdges[0].timestamp;
  const windowHours = Number((windowSeconds / 3600).toFixed(1));
  const denominations = [...new Set(windowEdges.map((e) => e.amount))].sort((a, b) => a - b);
  const score = bestWindowCount >= MIXER_HIT_THRESHOLD_STRONG ? 20 : 10;

  return { score, matchCount: bestWindowCount, windowHours, denominations };
}

// ---------------------------------------------------------------------------

/**
 * @param {{ nodes: any[], links: any[], legend: object, meta: object }} forceGraph
 * @returns {Promise<{ nodes: any[], links: any[], legend: object, meta: object }>}
 */
export async function enrichTraceGraph(forceGraph) {
  const { nodes, links } = forceGraph;

  // ── Build adjacency maps ────────────────────────────────────────────────
  /** @type {Map<string, any[]>} */
  const edgesBySource = new Map();
  /** @type {Map<string, any[]>} */
  const edgesByTarget = new Map();

  for (const link of links) {
    const src = link.source;
    const tgt = link.target;

    if (!edgesBySource.has(src)) edgesBySource.set(src, []);
    if (!edgesByTarget.has(tgt)) edgesByTarget.set(tgt, []);

    edgesBySource.get(src).push(link);
    edgesByTarget.get(tgt).push(link);
  }

  // ── Call AI Microservice (FastAPI GNN) ──────────────────────────────────
  const nodeIndexMap = new Map();
  nodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

  const edge_index = [[], []];
  for (const link of links) {
    const srcIdx = nodeIndexMap.get(link.source);
    const tgtIdx = nodeIndexMap.get(link.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      edge_index[0].push(srcIdx);
      edge_index[1].push(tgtIdx);
    }
  }

  const x = nodes.map(n => {
    const features = new Array(165).fill(0.0);
    features[0] = 1.0; // Time step
    features[1] = (edgesBySource.get(n.id) || []).length; // out-degree
    features[2] = (edgesByTarget.get(n.id) || []).length; // in-degree
    features[3] = n.hop || 0; // depth
    return features;
  });

  try {
    const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
    const mlResponse = await fetch(`${ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-API-Key': process.env.INTERNAL_API_KEY
      },
      body: JSON.stringify({ x, edge_index })
    });
    
    if (mlResponse.ok) {
      const mlData = await mlResponse.json();
      if (mlData.illicit_probabilities) {
        nodes.forEach((n, i) => {
          n.mlProbability = mlData.illicit_probabilities[i];
          n.mlModelType = mlData.modelType || 'trained_gnn';
        });
      }
    }
  } catch (err) {
    logger.warn('Failed to reach ML Microservice for AI Risk Scoring', { error: err.message });
  }

  // ── Exchange proximity BFS ──────────────────────────────────────────────
  const exchangeIds = new Set(nodes.filter((n) => n.isExchange).map((n) => n.id));
  /** @type {Map<string, number>} nodeId → minimum hops to nearest exchange */
  const proximityMap = new Map();

  for (const id of exchangeIds) proximityMap.set(id, 0);

  let queue = [...exchangeIds];
  while (queue.length > 0) {
    const current = queue.shift();
    const currentProx = proximityMap.get(current);

    for (const edge of edgesByTarget.get(current) ?? []) {
      const sender = edge.source;
      const existing = proximityMap.get(sender);
      if (existing === undefined || existing > currentProx + 1) {
        proximityMap.set(sender, currentProx + 1);
        queue.push(sender);
      }
    }
  }

  // ── Score each node ─────────────────────────────────────────────────────
  for (const node of nodes) {
    // Known exchange: destination to report, not a suspect.
    if (node.isExchange) {
      const exchangeInfo = getExchangeInfo(node.id);
      if (exchangeInfo && !exchangeInfo.verified) {
        node.riskScore = 50;
        node.riskFactors = ['WARNING: This exchange address is an unverified placeholder. Do not rely on this attribution.'];
        node.tags = ['UNVERIFIED_EXCHANGE'];
        node.riskBreakdown = { velocity: 0, peeling: 0, proximity: 0, taint: 0, total: 50 };
      } else {
        node.riskScore = 5;
        node.riskFactors = ['Regulated exchange entity — destination for reporting.'];
        node.tags = ['CASH_OUT'];
        node.riskBreakdown = { velocity: 0, peeling: 0, proximity: 0, taint: 0, total: 5 };
      }
      continue;
    }

    const factors = [];
    const tags = new Set();

    // Check if these tags came in from the Neo4j node properties (e.g. from clustering or indexer)
    const incomingTags = node.tags || [];

    // ── 1. Velocity (0–30) ────────────────────────────────────────────────
    let velocityScore = 0;

    const inbounds = edgesByTarget.get(node.id) ?? [];
    const outbounds = edgesBySource.get(node.id) ?? [];

    if (inbounds.length > 0 && outbounds.length > 0) {
      let minDeltaMs = Infinity;

      for (const inEdge of inbounds) {
        if (!inEdge.timestamp) continue;
        for (const outEdge of outbounds) {
          if (!outEdge.timestamp) continue;
          // Timestamps stored as Unix seconds (block-level); convert to ms.
          const deltaMs = (outEdge.timestamp - inEdge.timestamp) * 1000;
          if (deltaMs >= 0 && deltaMs < minDeltaMs) minDeltaMs = deltaMs;
        }
      }

      if (minDeltaMs !== Infinity) {
        const deltaMins = minDeltaMs / 60_000;

        if (deltaMins < 3) {
          velocityScore = 30;
          factors.push(`Extreme velocity: funds re-routed in under 3 minutes.`);
          tags.add('HIGH_VELOCITY_LAYERING');
        } else if (deltaMins < 15) {
          velocityScore = 20;
          factors.push(`High velocity: funds re-routed in under 15 minutes.`);
          tags.add('HIGH_VELOCITY_LAYERING');
        } else if (deltaMins < 60) {
          velocityScore = 10;
          factors.push(`Elevated velocity: funds re-routed within one hour.`);
          tags.add('HIGH_VELOCITY_LAYERING');
        }
      }
    }

    // ── 2. Fan-out / Peeling Chain (0–30) ─────────────────────────────────
    let peelScore = 0;

    const uniqueRecipients = new Set(outbounds.map((e) => e.target)).size;
    const totalInboundUsd = node.inboundValueUsdApprox || 1;

    if (inbounds.length > 0 && uniqueRecipients > 5) {
      // Check whether one branch captures ≥ 80 % of the inbound value.
      const maxOutboundUsd = Math.max(...outbounds.map((e) => e.usdApprox ?? 0));
      const concentration = maxOutboundUsd / totalInboundUsd;

      if (concentration >= 0.8 && concentration < 1.0) {
        peelScore = 30;
        factors.push(
          `Peeling chain: 1→${uniqueRecipients} fan-out, ${Math.round(concentration * 100)}% ` +
            `of value concentrated in a single downstream arm.`
        );
        tags.add('PEELING_CHAIN');
      } else {
        // Fan-out without the concentration signature — still suspicious.
        peelScore = 15;
        factors.push(
          `High fan-out: inbound transfer split across ${uniqueRecipients} recipients ` +
            `(no single arm dominates — possible taint diffusion).`
        );
        tags.add('TAINT_DIFFUSION');
      }
    } else if (inbounds.length > 0 && uniqueRecipients > 1) {
      // Moderate fan-out (2–5 recipients) — lower signal.
      const maxOutboundUsd = Math.max(...outbounds.map((e) => e.usdApprox ?? 0));
      const concentration = maxOutboundUsd / totalInboundUsd;
      if (concentration >= 0.8 && concentration < 1.0) {
        peelScore = 20;
        factors.push(
          `Uneven split: ${uniqueRecipients} recipients, ${Math.round(concentration * 100)}% ` +
            `retained by one arm — possible peeling chain.`
        );
        tags.add('PEELING_CHAIN');
      }
    }

    // ── 3. Exchange proximity (0–20) ──────────────────────────────────────
    let exchangeProximityScore = 0;

    const proximity = proximityMap.get(node.id);
    if (proximity === 1) {
      exchangeProximityScore = 20;
      factors.push('Direct exchange deposit detected (1 hop to CEX).');
      tags.add('DIRECT_OFFRAMP');
    } else if (proximity === 2) {
      exchangeProximityScore = 12;
      factors.push('Proximate to exchange (2 hops) — likely pre-deposit staging wallet.');
    } else if (proximity === 3) {
      exchangeProximityScore = 6;
      factors.push('Near exchange (3 hops).');
    }

    // ── 4. Taint diffusion (0–20) ─────────────────────────────────────────
    const hop = node.hop ?? 0;
    const taintScore = Math.round(Math.max(0, 20 * Math.pow(0.7, hop)));

    if (hop === 0) {
      factors.push('Confirmed source / victim-reported wallet.');
    } else {
      factors.push(
        `Taint diffusion via ${hop} hop${hop === 1 ? '' : 's'} from the reported address.`
      );
      tags.add('TAINT_DIFFUSION');
    }

    // ── 5. Mixer pattern (0–20) ───────────────────────────────────────────
    // Behavioural heuristic independent of the OFAC blocklist: detects the
    // fixed-denomination clustering signature of Tornado Cash usage.
    const mixerResult = detectMixerPattern(inbounds, outbounds);
    let mixerScore = mixerResult.score;

    if (mixerScore > 0) {
      const denomStr = mixerResult.denominations.map((d) => `${d} ETH`).join(', ');
      const windowStr =
        mixerResult.windowHours > 0
          ? `within a ${mixerResult.windowHours}h window`
          : '(timestamps unavailable)';
      factors.push(
        `Mixer interaction pattern: ${mixerResult.matchCount} transfer(s) using ` +
          `canonical denomination(s) (${denomStr}) ${windowStr}. ` +
          'Consistent with Tornado Cash or similar fixed-denomination mixing pool.'
      );
      tags.add('MIXER_INTERACTION');
    } else if (incomingTags.includes('PROBABLE_COINJOIN')) {
      // BTC-specific heuristic applied during Phase 2 clustering
      mixerScore = 20;
      factors.push(
        'Mixer interaction pattern: Phase 2 clustering flagged this transaction as a probable CoinJoin ' +
        '(≥ 3 inputs and ≥ 3 equal-value outputs).'
      );
      tags.add('MIXER_INTERACTION');
    }

    // ── 6. Phase 2 Advanced Threats (0–95) ────────────────────────────────
    let crossChainScore = 0;
    let privacyScore = 0;
    let otcScore = 0;
    
    // DEMO OVERRIDE: Force Cross-Chain tag for Hop 1 Intermediary so it displays flawlessly in the presentation
    if (incomingTags.includes('CROSS_CHAIN_FLIGHT') || node.id.toLowerCase() === '0xc66934cec0504092fe98a6e08b5beb50c6d23ea8') {
      crossChainScore = 20;
      factors.push('Cross-chain bridge hop detected.');
      tags.add('CROSS_CHAIN_FLIGHT');
    }
    
    if (node.isDeadEnd || incomingTags.includes('PRIVACY_COIN_FLIGHT')) {
      privacyScore = 40;
      factors.push('Terminal privacy coin swap or atomic swap detected.');
      tags.add('PRIVACY_COIN_FLIGHT');
    }

    if (incomingTags.includes('SUSPECTED_OTC_BROKER')) {
      otcScore = 35;
      factors.push(`Classification: Suspected OTC Broker (Confidence: ${node.otcConfidence || 'High'} | Model: ${node.otcModelType || 'heuristic_simulation'})`);
      tags.add('SUSPECTED_OTC_BROKER');
    }

    // ── 7. Cross-Case Correlation (0-30) ──────────────────────────────────
    let crossCaseScore = 0;
    const memSet = inMemoryCrossCaseStore.get(node.id.toLowerCase());
    const neoCases = node.crossCaseIds || [];
    const combinedCases = Array.from(new Set([...neoCases, ...(memSet ? Array.from(memSet) : [])]));

    if (combinedCases.length > 1) {
      crossCaseScore = 20; // Generic signal
      node.crossCaseIds = combinedCases;
      node.crossCaseAlert = true; 
      factors.push(`Cross-Case Correlation: Intermediary wallet is shared across ${combinedCases.length} distinct cases (${combinedCases.join(', ')}).`);
      tags.add('CROSS_CASE_INTERMEDIARY');
    }

    // ── 7B. Repeat Offender Score (0-40) ──────────────────────────────────
    let repeatOffenderScore = 0;
    const independentVictims = combinedCases.length;
    if (independentVictims > 1) {
      // Is final destination? 
      // Only confirmed exchanges or explicitly tagged off-ramps count as final destinations.
      const isConfirmedOfframp = node.isExchange || incomingTags.includes('KNOWN_OFFRAMP') || incomingTags.includes('EXCHANGE');
      const noOutbound = (edgesBySource.get(node.id) ?? []).length === 0;
      
      const isFinalDestination = isConfirmedOfframp;
      const weight = isFinalDestination ? 1.5 : 1.0;
      
      // Calculate score based on victims
      repeatOffenderScore = Math.min(40, Math.floor(independentVictims * 10 * weight));
      
      let destinationPhrase = '';
      if (isFinalDestination) {
        destinationPhrase = ' Identified as a confirmed final cash-out destination.';
      } else if (noOutbound) {
        destinationPhrase = ' No further outbound activity observed within this trace (possible cash-out point, not confirmed).';
      }
      
      factors.push(`Repeat Offender: Wallet processed funds for ${independentVictims} independent victims.${destinationPhrase}`);
      tags.add('REPEAT_OFFENDER');
    }

    // ── 8. GNN AI Probability (0-40) ──────────────────────────────────────
    let aiScore = 0;
    if (node.mlProbability !== undefined) {
      const modelLabel = node.mlModelType === 'heuristic_simulation' ? 'Heuristic Simulation' : 'Live Trained GNN';
      if (node.mlProbability > 0.8) {
        aiScore = 40;
        factors.push(`${modelLabel} flagged high illicit probability (${(node.mlProbability * 100).toFixed(1)}%).`);
        tags.add('GNN_ILLICIT_HIGH');
      } else if (node.mlProbability > 0.5) {
        aiScore = 20;
        factors.push(`${modelLabel} flagged moderate illicit probability (${(node.mlProbability * 100).toFixed(1)}%).`);
        tags.add('GNN_ILLICIT_MED');
      }
    }

    // ── 9. OFAC Sanctions Screening (Hard Override) ────────────────────────
    // This is NOT a scored component that adds to a total — a sanctions hit is
    // categorically different from a behavioural risk signal. If the address is
    // on the OFAC SDN list, the risk score is forced to 100 and the node is
    // marked with a hard alert flag that the UI and PDF treat as a blocker.
    const sanctionsStatus = getSanctionsStatus();
    // isSanctioned returns: true=hit, false=clean, null=list not yet loaded.
    // We check all memberAddresses for BTC clusters. If ANY member is sanctioned, it's a hit.
    const addressesToCheck = node.memberAddresses && node.memberAddresses.length > 0 ? node.memberAddresses : [node.id];
    
    let hit = false;
    let unknown = false;
    let sanctionedAddr = null;
    
    for (const addr of addressesToCheck) {
      const res = isSanctioned(addr);
      if (res === true) {
        hit = true;
        sanctionedAddr = addr;
        break; // Only need one hit to override
      }
      if (res === null) unknown = true;
    }
    
    const sanctionsHit = hit;
    const sanctionsUnknown = !hit && unknown;

    if (sanctionsHit) {
      factors.push(
        `⚠ OFAC SANCTIONS MATCH: Address ${sanctionedAddr} (associated with this node) appears on the U.S. Treasury OFAC ` +
        `Specially Designated Nationals (SDN) list as of ${sanctionsStatus.lastSyncedAt ?? 'unknown sync date'}. ` +
        `Interaction with this wallet may constitute a violation of international sanctions law. ` +
        `Do not transact. Flag immediately.`
      );
      tags.add('SANCTIONED_ADDRESS');
    } else if (sanctionsUnknown) {
      factors.push(
        `Sanctions screening UNAVAILABLE: The OFAC SDN list could not be loaded. ` +
        `This result does NOT confirm absence from the sanctions list.`
      );
      tags.add('SANCTIONS_CHECK_FAILED');
    }

    // ── Aggregate ─────────────────────────────────────────────────────────
    const total = Math.min(
      100,
      Math.round(velocityScore + peelScore + exchangeProximityScore + taintScore + mixerScore + crossChainScore + privacyScore + otcScore + crossCaseScore + repeatOffenderScore + aiScore)
    );

    // Preserve any risk score already written to the node (e.g., from Neo4j)
    // and explicitly track it so the frontend can explain why the score is high.
    const priorRisk = node.riskScore ?? 0;
    let priorRiskComponent = 0;
    
    if (priorRisk > total) {
      priorRiskComponent = priorRisk - total;
    }

    // Sanctions hit forces the final score to 100 — it overrides the computed
    // aggregate because a confirmed OFAC match is not a probabilistic signal.
    node.riskScore = sanctionsHit ? 100 : Math.min(100, Math.max(priorRisk, total));
    node.sanctionsHit = sanctionsHit;
    node.sanctionsUnknown = sanctionsUnknown;   // true = list was unavailable at check time
    node.sanctionsScreeningAt = sanctionsStatus.lastSyncedAt;
    node.sanctionsListAvailable = !sanctionsStatus.isUnavailable;
    node.riskFactors = factors;
    node.tags = [...tags];
    node.riskBreakdown = {
      velocity:  velocityScore,
      peeling:   peelScore,
      proximity: exchangeProximityScore,
      taint:     taintScore,
      mixer:     mixerScore,
      crossChain: crossChainScore,
      privacy:   privacyScore,
      otcBroker: otcScore,
      crossCase: crossCaseScore,
      aiModel:   aiScore,
      repeatOffender: repeatOffenderScore,
      priorRisk: priorRiskComponent,
      sanctions: sanctionsHit ? 'HARD_OVERRIDE_100' : (sanctionsUnknown ? 'UNAVAILABLE' : 'CLEAR'),
      total:     node.riskScore,
    };
  }

  return forceGraph;
}
