/**
 * config/assets.js
 * ---------------------------------------------------------------------------
 * Which assets we trace, and how much of each counts as "worth tracing".
 *
 * Rationale for tracking stablecoins rather than only the native coin: in real
 * Indian cyber-fraud cases (investment scams, "task" scams, pig-butchering)
 * the overwhelming majority of value moves as USDT, with ETH held only to pay
 * gas. A native-only tracer would follow the gas and miss the money.
 *
 * We use a strict ALLOWLIST rather than accepting every ERC-20. Ethereum is
 * awash with worthless airdrop-spam tokens deliberately sent to random wallets;
 * indexing them would inflate hop counts, add phantom edges between unrelated
 * victims, and make the Phase 4 graph unreadable.
 */

/**
 * @typedef {object} TrackedAsset
 * @property {string} symbol
 * @property {string} name
 * @property {string|null} contract Lowercase ERC-20 address; null for the native coin.
 * @property {number} decimals
 * @property {'native'|'stablecoin'} class
 */

/**
 * Per-network asset tables, keyed by the ALCHEMY_NETWORK slug.
 * Contract addresses are stored lowercase because that is our canonical form.
 * @type {Record<string, { native: TrackedAsset, tokens: TrackedAsset[] }>}
 */
const NETWORK_ASSETS = {
  'eth-mainnet': {
    native: {
      symbol: 'ETH',
      name: 'Ether',
      contract: null,
      decimals: 18,
      class: 'native',
    },
    tokens: [
      {
        symbol: 'USDT',
        name: 'Tether USD',
        contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        decimals: 6,
        class: 'stablecoin',
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 6,
        class: 'stablecoin',
      },
      {
        symbol: 'DAI',
        name: 'Dai Stablecoin',
        contract: '0x6b175474e89094c44da98b954eedeac495271d0f',
        decimals: 18,
        class: 'stablecoin',
      },
      {
        symbol: 'BUSD',
        name: 'Binance USD',
        contract: '0x4fabb145d64652a948d72533023f6e7a623c7c53',
        decimals: 18,
        class: 'stablecoin',
      },
    ],
  },

  'polygon-mainnet': {
    native: {
      symbol: 'POL',
      name: 'Polygon Ecosystem Token',
      contract: null,
      decimals: 18,
      class: 'native',
    },
    tokens: [
      {
        symbol: 'USDT',
        name: 'Tether USD (PoS)',
        contract: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
        decimals: 6,
        class: 'stablecoin',
      },
      {
        symbol: 'USDC.e',
        name: 'USD Coin (PoS, bridged)',
        contract: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
        decimals: 6,
        class: 'stablecoin',
      },
      {
        symbol: 'DAI',
        name: 'Dai Stablecoin (PoS)',
        contract: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
        decimals: 18,
        class: 'stablecoin',
      },
    ],
  },

  'eth-sepolia': {
    native: {
      symbol: 'ETH',
      name: 'Sepolia Ether',
      contract: null,
      decimals: 18,
      class: 'native',
    },
    // Add whichever test token you mint/use if you demo on Sepolia.
    tokens: [],
  },
};

/** Fallback used for networks we have not enumerated: native coin only. */
const GENERIC_FALLBACK = {
  native: { symbol: 'NATIVE', name: 'Native Coin', contract: null, decimals: 18, class: 'native' },
  tokens: [],
};

/**
 * Build the asset view for a given network.
 *
 * Returned once at startup and reused, so lookups in the traversal hot loop are
 * O(1) map hits rather than repeated array scans.
 *
 * @param {string} network ALCHEMY_NETWORK slug
 */
export function buildAssetRegistry(network) {
  const table = NETWORK_ASSETS[network] ?? GENERIC_FALLBACK;

  /** @type {Map<string, TrackedAsset>} contract address -> asset */
  const byContract = new Map(table.tokens.map((token) => [token.contract, token]));

  return {
    network,
    native: table.native,
    tokens: table.tokens,

    /** True when we have an enumerated table (i.e. token tracing is meaningful). */
    isKnownNetwork: Boolean(NETWORK_ASSETS[network]),

    /**
     * Resolve an Alchemy transfer to a tracked asset, or null to discard it.
     *
     * @param {object} transfer Raw `alchemy_getAssetTransfers` entry.
     * @returns {TrackedAsset|null}
     */
    resolve(transfer) {
      const contract = transfer?.rawContract?.address;

      // No contract address => value moved as the native coin.
      if (!contract) return table.native;

      // Contract present => must be on the allowlist, otherwise discard.
      return byContract.get(String(contract).toLowerCase()) ?? null;
    },

    /**
     * Minimum amount worth recording for this asset.
     * Native and stablecoin thresholds differ by orders of magnitude: 0.001 ETH
     * is a sensible floor, but 0.001 USDT is meaningless dust.
     *
     * @param {TrackedAsset} asset
     * @param {{ minNativeValue: number, minStableValue: number }} thresholds
     */
    dustThreshold(asset, thresholds) {
      return asset.class === 'native' ? thresholds.minNativeValue : thresholds.minStableValue;
    },
  };
}

/**
 * Alchemy `category` values to request.
 *
 *  - `external`: normal EOA-to-EOA sends of the native coin.
 *  - `erc20`:    token transfers (where the stablecoins live).
 *  - `internal`: value moved by contract execution. Genuinely important for
 *                tracing through routers, proxies and mixers - but it is served
 *                by Alchemy's trace API, which is not on the free tier. Gated
 *                behind INCLUDE_INTERNAL_TRANSFERS so a free-tier key does not
 *                get every request rejected outright.
 *
 * @param {{ includeInternalTransfers: boolean }} options
 * @returns {string[]}
 */
export function buildTransferCategories({ includeInternalTransfers }) {
  const categories = ['external', 'erc20'];
  if (includeInternalTransfers) categories.push('internal');
  return categories;
}
