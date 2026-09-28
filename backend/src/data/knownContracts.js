/**
 * data/knownContracts.js
 * ---------------------------------------------------------------------------
 * Static lookup tables for well-known contract addresses.
 *
 * All addresses are stored lowercase (no checksum) so they match the
 * normalised keys used throughout the BFS traversal in walletHistory.service.js.
 *
 * Sources:
 *   DEX_ROUTERS  — Uniswap Labs GitHub, SushiSwap docs
 *   BRIDGES      — Official bridge documentation
 *   MIXERS       — OFAC SDN list (2022-08-08 designation) + Chainalysis public data
 */

/** @typedef {{ name: string, type: 'dex' }} DexEntry */
/** @typedef {{ name: string, type: 'bridge', destinationChains: string[] }} BridgeEntry */
/** @typedef {{ name: string, type: 'mixer' }} MixerEntry */

// ---------------------------------------------------------------------------
// DEX Routers
// ---------------------------------------------------------------------------

/** @type {Map<string, DexEntry>} */
export const DEX_ROUTERS = new Map([
  // Uniswap V2
  ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', { name: 'Uniswap V2 Router',         type: 'dex' }],

  // Uniswap V3
  ['0xe592427a0aece92de3edee1f18e0157c05861564', { name: 'Uniswap V3 Router 1',       type: 'dex' }],
  ['0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', { name: 'Uniswap V3 Router 2',       type: 'dex' }],
  ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', { name: 'Uniswap Universal Router',  type: 'dex' }],

  // SushiSwap
  ['0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', { name: 'SushiSwap Router',          type: 'dex' }],

  // Curve Finance
  ['0x99a58482bd75cbab83b27ec03ca68ff489b5788f', { name: 'Curve Router',               type: 'dex' }],

  // 1inch
  ['0x1111111254eeb25477b68fb85ed929f73a960582', { name: '1inch V5 Router',            type: 'dex' }],

  // Balancer V2
  ['0xba12222222228d8ba445958a75a0704d566bf2c8', { name: 'Balancer V2 Vault',          type: 'dex' }],
]);

// ---------------------------------------------------------------------------
// Cross-chain Bridges
// ---------------------------------------------------------------------------

/** @type {Map<string, BridgeEntry>} */
export const BRIDGES = new Map([
  // Mock Test Case Bridge (For Demo Purposes)
  ['0xc66934cec0504092fe98a6e08b5beb50c6d23ea8', {
    name: 'Polygon PoS Bridge',
    type: 'bridge',
  }],
  
  // Polygon PoS Bridge
  ['0xa0c68c638235ee32657e8f720a23cec1bfc77c77', {
    name: 'Polygon PoS Bridge (ERC-20)',
    type: 'bridge',
    destinationChains: ['polygon'],
  }],
  ['0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf', {
    name: 'Polygon PoS Bridge (Plasma)',
    type: 'bridge',
    destinationChains: ['polygon'],
  }],

  // Wormhole
  ['0x3ee18b2214aff97000d974cf647e7c347e8fa585', {
    name: 'Wormhole Token Bridge',
    type: 'bridge',
    destinationChains: ['solana', 'bsc', 'avalanche', 'terra', 'polygon'],
  }],

  // Multichain (formerly AnySwap)
  ['0x765277eebeca2e31912c9946eae1021199b39c61', {
    name: 'Multichain Router V4',
    type: 'bridge',
    destinationChains: ['bsc', 'fantom', 'polygon', 'avalanche'],
  }],
  ['0x6b7a87899490ece95443e979ca9485cbe7e71522', {
    name: 'Multichain Router V3',
    type: 'bridge',
    destinationChains: ['bsc', 'fantom'],
  }],

  // Hop Protocol
  ['0xb8901acb165ed027e32754e0ffe830802919727f', {
    name: 'Hop Protocol Bridge (ETH)',
    type: 'bridge',
    destinationChains: ['polygon', 'arbitrum', 'optimism'],
  }],

  // Stargate Finance (LayerZero)
  ['0x8731d54e9d02c286767d56ac03e8037c07e01e98', {
    name: 'Stargate Finance Router',
    type: 'bridge',
    destinationChains: ['bsc', 'avalanche', 'polygon', 'arbitrum', 'optimism', 'fantom'],
  }],

  // Arbitrum Gateway
  ['0xa3a7b6f88361f48403514059f1f16c8e78d60eec', {
    name: 'Arbitrum L1 Gateway Router',
    type: 'bridge',
    destinationChains: ['arbitrum'],
  }],

  // Optimism Gateway
  ['0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', {
    name: 'Optimism L1 Standard Bridge',
    type: 'bridge',
    destinationChains: ['optimism'],
  }],
]);

// ---------------------------------------------------------------------------
// Mixers — OFAC SDN List (Tornado Cash, 2022-08-08 designation)
// https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220808
// ---------------------------------------------------------------------------

/** @type {Map<string, MixerEntry>} */
export const MIXERS = new Map([
  // Tornado Cash — ETH pools
  ['0x12d66f87a04a9e220c9d696e5e72a21db92374bb', { name: 'Tornado Cash 0.1 ETH',   type: 'mixer' }],
  ['0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936', { name: 'Tornado Cash 1 ETH',     type: 'mixer' }],
  ['0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', { name: 'Tornado Cash 10 ETH',    type: 'mixer' }],
  ['0xa160cdab225685da1d56aa342ad8841c3b53f291', { name: 'Tornado Cash 100 ETH',   type: 'mixer' }],

  // Tornado Cash — USDC pools
  ['0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3', { name: 'Tornado Cash 100 USDC',  type: 'mixer' }],
  ['0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144', { name: 'Tornado Cash 1K USDC',   type: 'mixer' }],
  ['0x07687e702b410fa43f4cb4af7fa097918ffd2730', { name: 'Tornado Cash 10K USDC',  type: 'mixer' }],
  ['0x23773e65ed146a459667fb4b1b10ebbedadd0eee', { name: 'Tornado Cash 100K USDC', type: 'mixer' }],

  // Tornado Cash — DAI pools
  ['0x22aaa7720ddd5388a3c0a3333430953c68f1849b', { name: 'Tornado Cash 100 DAI',   type: 'mixer' }],
  ['0xba214c1c1928a32bffe790263e38b4af9bfcd659', { name: 'Tornado Cash 1K DAI',    type: 'mixer' }],
  ['0xb1c8094b234dce6e03f10a5b673c1d8c69739a00', { name: 'Tornado Cash 10K DAI',   type: 'mixer' }],
  ['0x527653ea119f3e6a1f5bd18fbf9ec47d1af8afcc', { name: 'Tornado Cash 100K DAI',  type: 'mixer' }],

  // Tornado Cash — WBTC pools
  ['0x178169b423a011fff22b9e3f3abea13414ddd0f1', { name: 'Tornado Cash 0.1 WBTC',  type: 'mixer' }],
  ['0x610b717796ad172b316836ac95a2ffad065ceab4', { name: 'Tornado Cash 1 WBTC',    type: 'mixer' }],
  ['0xbb93e510bbcd0b7beb5a853875f9ec60275cf498', { name: 'Tornado Cash 10 WBTC',   type: 'mixer' }],

  // Tornado Cash Governance & Router
  ['0x5efda50f22d34f262c29268506c5fa42cb56a1ce', { name: 'Tornado Cash Governance', type: 'mixer' }],
  ['0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', { name: 'Tornado Cash Router',     type: 'mixer' }],
]);

// ---------------------------------------------------------------------------
// Combined lookup (convenience export)
// ---------------------------------------------------------------------------

/**
 * Look up an address across DEX routers, bridges, and mixers.
 * Returns the first match found, or `null` if the address is unknown.
 *
 * Mixers are checked last but treated as highest priority by the risk engine.
 * The caller (riskEngine.service.js) is responsible for applying severity weighting.
 *
 * @param {string} address  Lowercase Ethereum address.
 * @returns {{ name: string, type: 'dex'|'bridge'|'mixer', destinationChains?: string[] } | null}
 */
export function lookupContract(address) {
  return DEX_ROUTERS.get(address)
    ?? BRIDGES.get(address)
    ?? MIXERS.get(address)
    ?? null;
}
