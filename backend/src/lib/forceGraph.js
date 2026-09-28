/**
 * lib/forceGraph.js
 * ---------------------------------------------------------------------------
 * PHASE 3 presentation layer: turn traced paths into `{ nodes, links }` for
 * `react-force-graph-2d`.
 *
 * This lives in `lib/` rather than in the service because it contains no Cypher
 * and touches no database - it is a pure function from a trace result to a shape
 * a renderer understands. That makes it trivially testable, which matters, because
 * layout bugs are the kind that only show up as "the graph looks wrong" once
 * there is a UI to look at.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SERVER DOES THIS AND NOT THE BROWSER
 *
 * Node roles, sizes and colours are analytical decisions - which wallet is the
 * exchange, how suspicious a node is, how much value moved through it. Deciding
 * them here keeps one source of truth, so the sidebar and the canvas can never
 * disagree, and a future export-to-PDF gets the same answer as the screen.
 *
 * -----------------------------------------------------------------------------
 * ON MIXING ASSETS IN ONE "VOLUME" NUMBER
 *
 * Node size is driven by value flowing through the wallet, and a wallet can move
 * both ETH and USDT. Adding 0.5 to 32500 would be meaningless, so amounts are
 * converted to rough USD using the same `NATIVE_USD_HINT` that Phase 1 uses to
 * rank branches. It is explicitly a DISPLAY heuristic: `volumeUsdApprox` is named
 * to say so, the raw per-asset totals travel alongside it, and no reported figure
 * anywhere else in the system is derived from it.
 */

import { shortenAddress, toChecksum } from './addresses.js';
import { approximateUsd, describeValuation } from './valuation.js';

/**
 * Visual roles. The Phase 4 brief asks for a green source, grey intermediaries
 * and a large red exchange, so those three are fixed here; `context` is the
 * off-path fan-out, drawn faintly.
 */
export const NODE_ROLES = Object.freeze({
  SOURCE: 'source',
  INTERMEDIARY: 'intermediary',
  EXCHANGE: 'exchange',
  CONTEXT: 'context',
});

/**
 * Palette, served to the frontend rather than hardcoded in it, so the legend and
 * the canvas cannot drift apart.
 *
 * Deliberately not a rainbow: on a dark analytical dashboard the eye should land
 * on the exchange first, then the source, and treat everything else as plumbing.
 */
export const ROLE_STYLES = Object.freeze({
  [NODE_ROLES.SOURCE]: Object.freeze({
    color: '#22c55e',
    description: 'The victim-reported wallet the trace started from',
  }),
  [NODE_ROLES.INTERMEDIARY]: Object.freeze({
    color: '#94a3b8',
    description: 'A pass-through wallet on the route to an exchange',
  }),
  [NODE_ROLES.EXCHANGE]: Object.freeze({
    color: '#ef4444',
    description: 'A centralised exchange deposit address - the cash-out point',
  }),
  [NODE_ROLES.CONTEXT]: Object.freeze({
    color: '#475569',
    description: 'A wallet one hop off the traced route, shown for context',
  }),
});

/**
 * Node radius bands, in the units react-force-graph uses for `val`.
 *
 * Exchanges are scaled in their own band ABOVE every other node rather than on
 * one shared scale, and the reason is worth stating. On pure volume a
 * pass-through wallet routinely out-sizes the exchange it feeds: it carries both
 * the inbound and the outbound leg of every transfer, so its throughput is
 * roughly double. That number is honest, but rendering a mule wallet as the
 * biggest circle on screen inverts the hierarchy - the cash-out point is the
 * ANSWER, and it has to be what the eye lands on first.
 *
 * Two bands keep both properties: the exchange always reads largest, and within
 * each band relative volumes still separate nodes, so a venue receiving
 * 32,500 USDT still looks bigger than one receiving 2 ETH. Nothing is hidden
 * either - `volumeUsdApprox` travels with every node for the sidebar and tooltip.
 */
const WALLET_VAL_BAND = Object.freeze({ min: 2, max: 11 });
const EXCHANGE_VAL_BAND = Object.freeze({ min: 12, max: 18 });

/**
 * Map a volume onto a node radius within one band.
 *
 * Square root, not linear: traced volumes routinely span four orders of
 * magnitude, and a linear scale would render every wallet except the largest as
 * a dot. Square root is also what makes AREA proportional to volume, which is how
 * people actually read circle sizes.
 *
 * @param {number} volume
 * @param {number} maxVolume Largest volume in the same band.
 * @param {{ min: number, max: number }} band
 */
function scaleNodeVal(volume, maxVolume, band) {
  if (!(maxVolume > 0) || !(volume > 0)) return band.min;
  const ratio = Math.sqrt(volume / maxVolume);
  return Number((band.min + ratio * (band.max - band.min)).toFixed(2));
}

/**
 * Map an amount onto an edge width.
 * @param {number} usd
 * @param {number} maxUsd
 */
function scaleLinkWidth(usd, maxUsd) {
  if (!(maxUsd > 0) || !(usd > 0)) return 1;
  return Number((1 + Math.sqrt(usd / maxUsd) * 5).toFixed(2));
}

/**
 * Accumulate a wallet's entry in the node map.
 *
 * @param {Map<string, any>} nodes
 * @param {string} address
 * @param {object} seed
 */
function upsertNode(nodes, address, seed = {}) {
  if (!address) return null;

  const existing = nodes.get(address);
  if (!existing) {
    const created = {
      id: address,
      addressDisplay: seed.addressDisplay ?? toChecksum(address),
      isExchange: Boolean(seed.isExchange),
      exchange: seed.exchange ?? null,
      exchangeLabel: seed.exchangeLabel ?? null,
      riskScore: seed.riskScore ?? null,
      contractTag: seed.contractTag ?? null,
      // Minimum hop across every path this wallet appears on. A wallet reached
      // at hop 2 on one route and hop 4 on another is a hop-2 wallet: that is
      // the closest it has been shown to sit to the reported address.
      hop: seed.hop ?? null,
      tags: seed.tags ?? null,
      memberAddresses: seed.memberAddresses ?? null,
      onPath: Boolean(seed.onPath),
      inboundValueUsdApprox: 0,
      outboundValueUsdApprox: 0,
      inboundCount: 0,
      outboundCount: 0,
      totalsByAsset: {},
      /** Which of the returned routes this wallet participates in, by index. */
      pathIndices: new Set(),
    };
    nodes.set(address, created);
    return created;
  }

  // Merge: later mentions may know more than the first one did.
  if (seed.addressDisplay) existing.addressDisplay = seed.addressDisplay;
  if (seed.isExchange) existing.isExchange = true;
  if (seed.exchange && !existing.exchange) existing.exchange = seed.exchange;
  if (seed.exchangeLabel && !existing.exchangeLabel) existing.exchangeLabel = seed.exchangeLabel;
  if (seed.contractTag && !existing.contractTag) existing.contractTag = seed.contractTag;
  if (seed.swapEvent && !existing.swapEvent) existing.swapEvent = seed.swapEvent;
  if (seed.tags && !existing.tags) existing.tags = seed.tags;
  if (seed.memberAddresses && !existing.memberAddresses) existing.memberAddresses = seed.memberAddresses;
  if (seed.riskScore !== null && seed.riskScore !== undefined && existing.riskScore === null) {
    existing.riskScore = seed.riskScore;
  }
  if (seed.onPath) existing.onPath = true;
  if (Number.isFinite(seed.hop)) {
    existing.hop = existing.hop === null ? seed.hop : Math.min(existing.hop, seed.hop);
  }
  return existing;
}

/**
 * Record value moving along one edge against both endpoints.
 * @param {Map<string, any>} nodes
 * @param {{ from: string, to: string, amount: number, asset: string|null, assetClass?: string|null }} edge
 */
function accumulateFlow(nodes, edge) {
  const usd = approximateUsd(edge);
  const asset = edge.asset ?? 'unknown';

  const sender = nodes.get(edge.from);
  if (sender) {
    sender.outboundValueUsdApprox += usd;
    sender.outboundCount += 1;
    const bucket = (sender.totalsByAsset[asset] ??= { in: 0, out: 0 });
    bucket.out += Number(edge.amount ?? 0);
  }

  const recipient = nodes.get(edge.to);
  if (recipient) {
    recipient.inboundValueUsdApprox += usd;
    recipient.inboundCount += 1;
    const bucket = (recipient.totalsByAsset[asset] ??= { in: 0, out: 0 });
    bucket.in += Number(edge.amount ?? 0);
  }

  return usd;
}

/**
 * Convert a `findCashOutPaths` result into a force-graph payload.
 *
 * @param {object} traceResult The object returned by `findCashOutPaths`.
 * @returns {{ nodes: any[], links: any[], legend: object, meta: object }}
 */
export function toForceGraph(traceResult) {
  /** @type {Map<string, any>} */
  const nodes = new Map();
  /** Keyed on uniqueId so an edge shared by two routes appears once. */
  const links = new Map();

  const startAddress = traceResult?.start?.address ?? traceResult?.query?.address ?? null;

  if (startAddress) {
    upsertNode(nodes, startAddress, {
      addressDisplay: traceResult.start?.addressDisplay,
      riskScore: traceResult.start?.riskScore ?? null,
      isExchange: traceResult.start?.isExchange,
      exchange: traceResult.start?.exchange,
      contractTag: traceResult.start?.contractTag,
      hop: 0,
      onPath: true,
    });
  }

  // --- On-path nodes and edges ---------------------------------------------

  const paths = traceResult?.paths ?? [];

  paths.forEach((path, pathIndex) => {
    for (const step of path.steps ?? []) {
      const sender = upsertNode(nodes, step.from, {
        addressDisplay: step.fromDisplay,
        contractTag: step.fromContractTag,
        tags: step.fromTags,
        memberAddresses: step.fromMembers,
        hop: step.hop - 1,
        onPath: true,
      });
      const recipient = upsertNode(nodes, step.to, {
        addressDisplay: step.toDisplay,
        isExchange: step.toIsExchange,
        riskScore: step.toRiskScore,
        contractTag: step.toContractTag,
        swapEvent: step.swapEvent,
        tags: step.toTags,
        memberAddresses: step.toMembers,
        hop: step.hop,
        onPath: true,
      });

      sender?.pathIndices.add(pathIndex);
      recipient?.pathIndices.add(pathIndex);

      // The final wallet on the route is the exchange, so attach the operator
      // name and label there. The step itself does not carry them.
      if (step.hop === path.hops && recipient) {
        recipient.isExchange = true;
        recipient.exchange ??= path.exchange?.exchange ?? null;
        recipient.exchangeLabel ??= path.exchange?.label ?? null;
      }

      // Keyed on uniqueId, falling back to a composite key: two different routes
      // through the same pair of wallets are different edges, but the SAME edge
      // reached by two routes must not be drawn twice.
      const key = step.uniqueId ?? `${step.from}->${step.to}:${step.hash}`;
      const existing = links.get(key);

      if (existing) {
        existing.pathIndices.add(pathIndex);
      } else {
        links.set(key, {
          id: key,
          source: step.from,
          target: step.to,
          hash: step.hash,
          amount: step.amount,
          asset: step.asset,
          assetClass: step.assetClass,
          timestamp: step.timestamp,
          blockNumber: step.blockNumber,
          hop: step.hop,
          onPath: true,
          pathIndices: new Set([pathIndex]),
          _usd: approximateUsd(step),
        });
        accumulateFlow(nodes, step);
      }
    }
  });

  // --- Off-path context ----------------------------------------------------

  for (const edge of traceResult?.contextEdges ?? []) {
    // The source of a context edge is by definition already on a path; only the
    // target is new.
    upsertNode(nodes, edge.to, {
      addressDisplay: edge.toDisplay,
      isExchange: edge.toIsExchange,
      exchange: edge.toExchange,
      riskScore: edge.toRiskScore,
      contractTag: edge.toContractTag ?? (edge.isBridge ? { type: 'bridge', name: edge.bridgeProtocol || 'Bridge' } : null),
      swapEvent: edge.swapEvent,
      onPath: false,
    });

    const key = edge.uniqueId ?? `${edge.from}->${edge.to}:${edge.hash}`;
    if (links.has(key)) continue;

    links.set(key, {
      id: key,
      source: edge.from,
      target: edge.to,
      hash: edge.hash,
      amount: edge.amount,
      asset: edge.asset,
      assetClass: edge.assetClass ?? null,
      timestamp: edge.timestamp,
      blockNumber: edge.blockNumber ?? null,
      hop: null,
      onPath: false,
      isBridge: Boolean(edge.isBridge),
      bridgeProtocol: edge.bridgeProtocol ?? null,
      pathIndices: new Set(),
      _usd: approximateUsd(edge),
    });
    accumulateFlow(nodes, edge);
  }

  // --- Roles, sizes, colours ----------------------------------------------

  const nodeList = [...nodes.values()];

  for (const node of nodeList) {
    node.volumeUsdApprox = Number(
      (node.inboundValueUsdApprox + node.outboundValueUsdApprox).toFixed(2)
    );

    if (node.id === startAddress) {
      node.role = NODE_ROLES.SOURCE;
    } else if (node.isExchange) {
      node.role = NODE_ROLES.EXCHANGE;
    } else if (node.onPath) {
      node.role = NODE_ROLES.INTERMEDIARY;
    } else {
      node.role = NODE_ROLES.CONTEXT;
    }

    node.color = ROLE_STYLES[node.role].color;
    // The brief asks for a pulsing exchange node. Whether to animate is the
    // renderer's business; which nodes deserve it is ours.
    node.emphasis = node.role === NODE_ROLES.EXCHANGE;

    // Short label for the canvas; the full address is in `addressDisplay` for
    // the sidebar and for copy-to-clipboard. `shortenAddress` rather than a hand
    // rolled slice, so a malformed address short enough for the two slices to
    // overlap degrades to itself instead of to nonsense.
    node.label = node.contractTag?.name ?? node.exchangeLabel ?? node.exchange ?? shortenAddress(node.addressDisplay);

    // Round the per-asset totals last, so accumulated float error is not baked
    // into the intermediate sums.
    for (const [asset, bucket] of Object.entries(node.totalsByAsset)) {
      node.totalsByAsset[asset] = {
        in: Number(bucket.in.toFixed(6)),
        out: Number(bucket.out.toFixed(6)),
      };
    }

    node.inboundValueUsdApprox = Number(node.inboundValueUsdApprox.toFixed(2));
    node.outboundValueUsdApprox = Number(node.outboundValueUsdApprox.toFixed(2));
    node.pathIndices = [...node.pathIndices].sort((a, b) => a - b);
  }

  // Each band is scaled against its OWN maximum, so one whale exchange cannot
  // flatten every wallet to the floor and vice versa.
  const exchanges = nodeList.filter((node) => node.role === NODE_ROLES.EXCHANGE);
  const wallets = nodeList.filter((node) => node.role !== NODE_ROLES.EXCHANGE);

  const maxExchangeVolume = exchanges.reduce((max, n) => Math.max(max, n.volumeUsdApprox), 0);
  const maxWalletVolume = wallets.reduce((max, n) => Math.max(max, n.volumeUsdApprox), 0);

  for (const node of exchanges) {
    node.val = scaleNodeVal(node.volumeUsdApprox, maxExchangeVolume, EXCHANGE_VAL_BAND);
    // A single exchange with no traced value would otherwise sit at the band
    // floor; midpoint reads better as "this is the answer" when it is alone.
    if (maxExchangeVolume <= 0) {
      node.val = (EXCHANGE_VAL_BAND.min + EXCHANGE_VAL_BAND.max) / 2;
    }
  }
  for (const node of wallets) {
    node.val = scaleNodeVal(node.volumeUsdApprox, maxWalletVolume, WALLET_VAL_BAND);
  }

  const linkList = [...links.values()];
  const maxLinkUsd = linkList.reduce((max, link) => Math.max(max, link._usd), 0);

  for (const link of linkList) {
    link.width = scaleLinkWidth(link._usd, maxLinkUsd);
    link.pathIndices = [...link.pathIndices].sort((a, b) => a - b);
    // Directional arrows are the whole point of this view - value flows one way.
    link.directed = true;
    delete link._usd;
  }

  // --- Deterministic ordering ---------------------------------------------
  // A force layout seeds from input order, so a stable sort keeps the picture
  // recognisable between reloads instead of rearranging itself each time.

  const rolePriority = {
    [NODE_ROLES.SOURCE]: 0,
    [NODE_ROLES.INTERMEDIARY]: 1,
    [NODE_ROLES.EXCHANGE]: 2,
    [NODE_ROLES.CONTEXT]: 3,
  };

  nodeList.sort((a, b) => {
    if (rolePriority[a.role] !== rolePriority[b.role]) {
      return rolePriority[a.role] - rolePriority[b.role];
    }
    const hopA = a.hop ?? 99;
    const hopB = b.hop ?? 99;
    if (hopA !== hopB) return hopA - hopB;
    return a.id.localeCompare(b.id);
  });

  linkList.sort((a, b) => {
    if (a.onPath !== b.onPath) return a.onPath ? -1 : 1;
    const hopA = a.hop ?? 99;
    const hopB = b.hop ?? 99;
    if (hopA !== hopB) return hopA - hopB;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    nodes: nodeList,
    links: linkList,
    /** Served so the UI legend is generated from the same source as the colours. */
    legend: {
      roles: Object.entries(ROLE_STYLES).map(([role, style]) => ({
        role,
        color: style.color,
        description: style.description,
      })),
      nodeSize:
        'Circle AREA grows with approximate USD value through the wallet. Exchange ' +
        'nodes are drawn in a larger size band than other wallets so the cash-out ' +
        'point always reads as the headline, even when a pass-through wallet moved ' +
        'more total value. Exact figures are on each node as volumeUsdApprox.',
      edgeWidth: 'Stroke width is proportional to approximate USD value of the transfer.',
      valuation: describeValuation(),
    },
    meta: {
      nodeCount: nodeList.length,
      linkCount: linkList.length,
      onPathNodes: nodeList.filter((node) => node.onPath).length,
      contextNodes: nodeList.filter((node) => !node.onPath).length,
      pathCount: paths.length,
    },
  };
}
