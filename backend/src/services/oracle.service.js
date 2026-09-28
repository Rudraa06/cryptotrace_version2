import { logger } from '../lib/logger.js';
import { config } from '../config/env.js';

// In-memory TTL cache: { [symbol: string]: { priceUsd: number, expiresAt: number } }
const priceCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// A fallback mapping of standard assets in case the API is completely unreachable
const FALLBACK_PRICES = {
  ETH: config.nativeUsdHint,
  USDT: 1.0,
  USDC: 1.0,
  DAI: 1.0,
  BTC: 60000.0,
};

// Map common symbols to CoinGecko IDs
const SYMBOL_TO_COINGECKO_ID = {
  ETH: 'ethereum',
  WETH: 'weth',
  BTC: 'bitcoin',
  WBTC: 'wrapped-bitcoin',
  USDT: 'tether',
  USDC: 'usd-coin',
  DAI: 'dai',
  MATIC: 'matic-network',
  BNB: 'binancecoin',
  SOL: 'solana'
};

/**
 * Fetch the current USD price of an asset from CoinGecko.
 * Uses an in-memory TTL cache to avoid rate limits on the public API (10-30 req/min).
 * No API key is required for the public /simple/price endpoint.
 *
 * @param {string} symbol The asset ticker (e.g., 'ETH', 'USDT')
 * @returns {Promise<number|null>} The USD price, or null if unknown
 */
export async function getAssetPriceUsd(symbol) {
  if (!symbol) return null;
  const upperSymbol = symbol.toUpperCase();

  // 1. Check Cache
  const cached = priceCache.get(upperSymbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.priceUsd;
  }

  // 2. Resolve CoinGecko ID
  // If we don't know the CoinGecko ID for this symbol, we can't look it up reliably
  // without a full coin list search, which is too slow. 
  // We rely on the predefined SYMBOL_TO_COINGECKO_ID map for top assets.
  const coinId = SYMBOL_TO_COINGECKO_ID[upperSymbol];
  
  if (!coinId) {
    // If it's a known stablecoin missing from the map, default to 1
    if (upperSymbol.includes('USD') || upperSymbol === 'DAI') return 1.0;
    // Otherwise fallback to whatever we know, or null
    return FALLBACK_PRICES[upperSymbol] || null;
  }

  // 3. Fetch from CoinGecko Public API
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000); // 2-second hard timeout
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CryptoTrace-Analytics-Node/1.0'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`CoinGecko HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (data[coinId] && data[coinId].usd) {
      const priceUsd = data[coinId].usd;
      
      // Update Cache
      priceCache.set(upperSymbol, {
        priceUsd,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      
      logger.debug(`[Oracle] Fetched price for ${upperSymbol}: $${priceUsd}`);
      return priceUsd;
    } else {
      throw new Error(`Response missing price data for ${coinId}`);
    }
  } catch (error) {
    logger.warn(`[Oracle] Failed to fetch price for ${upperSymbol}: ${error.message}. Using fallback.`);
    
    // Fallback if network/API is down
    if (FALLBACK_PRICES[upperSymbol]) {
      return FALLBACK_PRICES[upperSymbol];
    }
    // If it's a stablecoin by name, guess $1
    if (upperSymbol.includes('USD') || upperSymbol === 'DAI') return 1.0;
    
    // Revert to the crude static hint for the native token if it's ETH/WETH
    if (upperSymbol === 'ETH' || upperSymbol === 'WETH') {
      return config.nativeUsdHint;
    }
    
    
    return FALLBACK_PRICES[upperSymbol] || null;
  }
}

/**
 * Synchronous reader for the cache. Used by valuation.js to avoid async refactoring
 * deep inside graph construction loops.
 */
export function getCachedPriceUsd(symbol) {
  if (!symbol) return null;
  const upperSymbol = symbol.toUpperCase();
  const cached = priceCache.get(upperSymbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.priceUsd;
  }
  
  if (upperSymbol.includes('USD') || upperSymbol === 'DAI') return 1.0;
  if (upperSymbol === 'ETH' || upperSymbol === 'WETH') return config.nativeUsdHint;
  return FALLBACK_PRICES[upperSymbol] || null;
}
