/**
 * lib/valuation.js
 * ---------------------------------------------------------------------------
 * One rough asset-to-USD conversion, used wherever amounts in DIFFERENT assets
 * have to be compared against each other.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Two routes can end in different assets: one depositing 32,500 USDT and one
 * depositing 12 ETH. Comparing those numerically says the USDT route is nearly
 * three thousand times larger, when at any realistic ETH price it is smaller.
 * Any ranking, sizing or "which exchange received the most" answer built on the
 * raw numbers is therefore wrong in a way that looks authoritative.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DELIBERATELY CRUDE, AND WHERE IT MUST NOT BE USED
 * ---------------------------------------------------------------------------
 * There is no price oracle here. `NATIVE_USD_HINT` is a single fixed number from
 * config, so this is an ORDERING heuristic and nothing more. That is adequate for
 * its two jobs - breaking a tie between equally-close exchanges, and choosing a
 * circle size - because both only need the comparison to come out in the right
 * direction, not to be accurate.
 *
 * It must never appear in a reported figure. What landed at an exchange is
 * reported as its own amount in its own asset (`amountIntoExchange` /
 * `assetIntoExchange`), and every value derived from this function carries
 * `UsdApprox` in its name so it cannot be mistaken for one.
 *
 * ---------------------------------------------------------------------------
 * HOW AN ASSET'S CLASS IS DECIDED
 * ---------------------------------------------------------------------------
 * In order: the record's own `assetClass`, then the asset symbol looked up in the
 * network allowlist, then 1:1 as a last resort. The middle step exists because a
 * record that simply forgot to carry `assetClass` used to be priced as the native
 * coin, which silently multiplied every stablecoin transfer by NATIVE_USD_HINT.
 * Guessing "native" is the single most expensive guess available here, so it is
 * never the default.
 */

import { config } from '../config/env.js';
import { buildAssetRegistry } from '../config/assets.js';
import { getAssetPriceUsd, getCachedPriceUsd } from '../services/oracle.service.js';

/**
 * Pre-warms the price oracle cache for all unique assets found in a trace.
 * This runs asynchronously before graph construction to keep the tight loops
 * in forceGraph.js completely synchronous, avoiding hanging/performance bugs.
 */
export async function prefetchPrices(traceResult) {
  if (!traceResult) return;
  const assets = new Set();
  
  // Extract from on-path steps
  for (const path of traceResult.paths || []) {
    for (const step of path.steps || []) {
      if (step.asset) assets.add(step.asset);
    }
  }
  
  // Extract from context edges
  for (const edge of traceResult.contextEdges || []) {
    if (edge.asset) assets.add(edge.asset);
  }
  
  await Promise.all(Array.from(assets).map(asset => getAssetPriceUsd(asset)));
}

/**
 * Lazily-built `symbol -> 'native' | 'stablecoin'` map for the configured network.
 *
 * Built from the same allowlist the ingestion layer uses, so the two can never
 * disagree about what USDT is. Memoised because this is called once per edge while
 * sizing a graph, and built lazily so importing this module does not force config
 * resolution at import time.
 *
 * @type {Map<string, 'native'|'stablecoin'>|null}
 */
let symbolClasses = null;

function classOfSymbol(symbol) {
  if (!symbol) return null;

  if (symbolClasses === null) {
    const registry = buildAssetRegistry(config.network);
    symbolClasses = new Map();
    symbolClasses.set(String(registry.native.symbol).toUpperCase(), 'native');
    // Alchemy reports native transfers with the coin's ticker (ETH), while the
    // registry's own entry is the sentinel 'NATIVE' on unknown networks. Register
    // both so either spelling resolves.
    symbolClasses.set('NATIVE', 'native');
    for (const token of registry.tokens) {
      symbolClasses.set(String(token.symbol).toUpperCase(), token.class);
    }
  }

  return symbolClasses.get(String(symbol).toUpperCase()) ?? null;
}

/**
 * Approximate USD value of one transfer, for comparison only.
 *
 * @param {{ amount?: number|string|null, assetClass?: string|null, asset?: string|null }} transfer
 * @returns {number} USD estimate, or 0 when the amount is missing or unusable.
 */
export function approximateUsd(transfer) {
  const amount = Number(transfer?.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  // 1. Check Oracle Cache
  const oraclePrice = getCachedPriceUsd(transfer?.asset);
  if (oraclePrice !== null) {
    return amount * oraclePrice;
  }

  // Trust an explicit class when the record carries one.
  if (transfer?.assetClass === 'stablecoin') return amount;
  if (transfer?.assetClass === 'native') return amount * config.nativeUsdHint;

  // No class on the record. Fall back to the asset symbol rather than assuming
  // native: for a stablecoin that assumption multiplies the value by
  // NATIVE_USD_HINT, and a 3,000x overstatement on an off-path wallet is enough
  // to make it the biggest circle on the canvas. This is not hypothetical - the
  // context-edge query shipped without selecting `assetClass` and did exactly that.
  const inferred = classOfSymbol(transfer?.asset);
  if (inferred === 'native') return amount * config.nativeUsdHint;
  if (inferred === 'stablecoin') return amount;

  // Symbol is not on the allowlist either, so nothing here can price it. Ingestion
  // discards unlisted assets, so reaching this line means the row predates the
  // current allowlist. Treated 1:1 deliberately: still wrong, but wrong by a
  // factor near 1 instead of near NATIVE_USD_HINT, and it cannot promote an
  // unknown token to the largest node on screen.
  return amount;
}

/** Human-readable note on how the above was arrived at, for API responses. */
export function describeValuation() {
  return (
    `Cross-asset comparisons fetch live prices via CoinGecko when available. ` +
    `Fallbacks treat stablecoins as 1 USD and the native coin at a ` +
    `fixed NATIVE_USD_HINT of ${config.nativeUsdHint}. Used only for ranking and ` +
    `node sizing - never for a reported amount.`
  );
}

/** Test seam: drop the memoised symbol table so a suite can change the network. */
export function __resetValuationCache() {
  symbolClasses = null;
}
