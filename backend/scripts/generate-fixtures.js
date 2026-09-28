import { id as keccakId } from 'ethers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(PACKAGE_ROOT, 'fixtures', 'mock-transfers.json');

const synthAddress = (label) => keccakId(`sih-2026:${label}`).slice(0, 42).toLowerCase();

const W = {
  // Common exchanges
  binance14: '0x28c6c06298d514db089934071355e5743bf21d60',
  coinbase10: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3',
  okx: '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b',
  kraken: '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0',
  binanceInternal: synthAddress('binance-internal-shuffle'),

  // Contracts (must match knownContracts.js)
  uniswapV2Router: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  uniswapV3Router: '0xe592427a0aece92de3edee1f18e0157c05861564',
  polygonPoSBridge: '0xa0c68c638235ee32657e8f720a23cec1bfc77c77',
  tornadoCash10ETH: '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',

  // GROUP A: Baseline
  a1_suspect: synthAddress('a1-suspect'),
  a2_suspect: synthAddress('a2-suspect'),
  a2_hop1: synthAddress('a2-hop1'),
  a2_hop2: synthAddress('a2-hop2'),
  a3_suspect: synthAddress('a3-suspect'),
  a3_1: synthAddress('a3-1'), a3_2: synthAddress('a3-2'), a3_3: synthAddress('a3-3'),
  a3_4: synthAddress('a3-4'), a3_5: synthAddress('a3-5'), a3_6: synthAddress('a3-6'), a3_7: synthAddress('a3-7'),
  a4_suspect: synthAddress('a4-suspect-negative'),
  a4_hop1: synthAddress('a4-hop1'),
  a4_hop2: synthAddress('a4-hop2'),

  // GROUP B: Layering / Peeling
  b1_suspect: synthAddress('suspect-root'), // Keeps original name for smoke.js
  layer1A: synthAddress('layer1-a'),
  layer1B: synthAddress('layer1-b'),
  layer1C: synthAddress('layer1-c'),
  layer2A: synthAddress('layer2-a'),
  layer2B: synthAddress('layer2-b'),
  gasFeeder: synthAddress('gas-feeder'),
  dustDecoy: synthAddress('dust-decoy'),

  b2_suspect: synthAddress('b2-suspect'),
  b2_m1: synthAddress('b2-mule1'), b2_m2: synthAddress('b2-mule2'), b2_m3: synthAddress('b2-mule3'), b2_m4: synthAddress('b2-mule4'),

  b3_suspect: synthAddress('b3-suspect'),
  b3_m1: synthAddress('b3-mule1'), b3_m2: synthAddress('b3-mule2'), b3_m3: synthAddress('b3-mule3'), b3_m4: synthAddress('b3-mule4'),
  b3_recon: synthAddress('b3-recon'),

  // GROUP C: Smurfing
  c1_suspect: synthAddress('smurf-suspect'),
  c1_m1: synthAddress('smurf-mule1'), c1_m2: synthAddress('smurf-mule2'), c1_m3: synthAddress('smurf-mule3'),
  c1_m4: synthAddress('smurf-mule4'), c1_m5: synthAddress('smurf-mule5'),

  // GROUP D: Mixers
  d1_suspect: synthAddress('mixer-suspect'),
  d1_withdrawer: synthAddress('d1-withdrawer'),

  d2_suspect: synthAddress('d2-suspect'),
  d2_withdrawer: synthAddress('d2-withdrawer'),
  d2_sloppy: synthAddress('d2-sloppy-direct'),

  // GROUP E: DEX Swaps
  e1_suspect: synthAddress('e1-suspect'),
  e1_postSwap: synthAddress('e1-postswap'),
  
  e2_suspect: synthAddress('e2-suspect'),
  e2_postSwap1: synthAddress('e2-postswap1'),
  e2_postSwap2: synthAddress('e2-postswap2'),

  // GROUP F: Cross-chain Bridge
  f1_suspect: synthAddress('crosschain-suspect'),
  f1_poly1: synthAddress('crosschain-hop1'),
  f1_poly2: synthAddress('crosschain-hop2'),

  // GROUP G: Combined / Adversarial
  g1_suspect: synthAddress('g1-kitchen-sink'),
  g1_p1: synthAddress('g1-peel1'),
  g1_postSwap: synthAddress('g1-postswap'),
  g1_withdrawer: synthAddress('g1-withdrawer'),
  g1_poly1: synthAddress('g1-poly1'),

  g2_suspect: synthAddress('g2-dust-attack'),
  // We'll generate 20 dust recipients dynamically

  // GROUP H: Fraud Typologies
  h1_suspect: synthAddress('h1-sextortion'),
  h2_suspect: synthAddress('h2-ransomware'),
  h3_victim1: synthAddress('h3-victim1'), h3_victim2: synthAddress('h3-victim2'), h3_victim3: synthAddress('h3-victim3'),
  h3_suspect: synthAddress('h3-collection'),
  h4_victim1: synthAddress('h4-victim1'), h4_victim2: synthAddress('h4-victim2'),
  h4_suspect: synthAddress('h4-task-suspect'),

  // GROUP I: Cross-case correlation
  i_vic1: synthAddress('i-victim1'),
  i_vic2: synthAddress('i-victim2'),
  i_shared: synthAddress('i-shared-intermediary'),
  i_out1: synthAddress('i-out1'),
  i_out2: synthAddress('i-out2'),
};

const USDT = { symbol: 'USDT', contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 };
function toRawHex(amount, decimals) {
  const [whole, frac = ''] = String(amount).split('.');
  const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
  return `0x${BigInt(`${whole}${paddedFrac}`).toString(16)}`;
}

const BASE_BLOCK = 20_100_000;
const BASE_TIME = Date.parse('2026-07-14T09:12:00.000Z');
let sequence = 0;

function transfer({ from, to, amount, asset, hoursAfterBase }) {
  sequence += 1;
  const blockNum = BASE_BLOCK + Math.round(hoursAfterBase * 300);
  const timestamp = new Date(BASE_TIME + hoursAfterBase * 3_600_000).toISOString();
  const hash = keccakId(`sih-2026:tx:${sequence}:${from}:${to}:${amount}`).toLowerCase();
  const isNative = asset === 'ETH';
  const assetData = isNative ? { contract: null, decimals: 18 } : USDT;
  const valueNum = isNative ? amount : amount * Math.pow(10, assetData.decimals);

  return {
    blockNum: `0x${blockNum.toString(16)}`,
    uniqueId: `${hash}:${isNative ? 'external' : `log:${sequence}`}`,
    hash, from, to, value: valueNum,
    erc721TokenId: null, erc1155Metadata: null, tokenId: null, asset: isNative ? null : asset,
    category: isNative ? 'external' : 'erc20',
    rawContract: {
      value: toRawHex(amount, assetData.decimals),
      address: assetData.contract,
      decimal: `0x${assetData.decimals.toString(16)}`,
    },
    metadata: { blockTimestamp: timestamp },
  };
}

const transfersByAddress = {};

function add(address, txs) {
  if (!transfersByAddress[address]) transfersByAddress[address] = [];
  transfersByAddress[address].push(...txs);
}

// Seed exchanges with backend movement
add(W.binance14, [transfer({ from: W.binance14, to: W.binanceInternal, amount: 500000, asset: 'USDT', hoursAfterBase: 200 })]);
add(W.coinbase10, [transfer({ from: W.coinbase10, to: W.binanceInternal, amount: 250000, asset: 'USDT', hoursAfterBase: 200 })]);
add(W.okx, [transfer({ from: W.okx, to: W.binanceInternal, amount: 100000, asset: 'USDT', hoursAfterBase: 200 })]);
add(W.kraken, [transfer({ from: W.kraken, to: W.binanceInternal, amount: 100000, asset: 'USDT', hoursAfterBase: 200 })]);

// ============================================================================
// GROUP A — Baseline tracing
// ============================================================================
add(W.a1_suspect, [
  transfer({ from: W.a1_suspect, to: W.binance14, amount: 5000, asset: 'USDT', hoursAfterBase: 1 })
]);

add(W.a2_suspect, [
  transfer({ from: W.a2_suspect, to: W.a2_hop1, amount: 10000, asset: 'USDT', hoursAfterBase: 1 })
]);
add(W.a2_hop1, [
  transfer({ from: W.a2_hop1, to: W.a2_hop2, amount: 9900, asset: 'USDT', hoursAfterBase: 2 })
]);
add(W.a2_hop2, [
  transfer({ from: W.a2_hop2, to: W.coinbase10, amount: 9800, asset: 'USDT', hoursAfterBase: 3 })
]);

add(W.a3_suspect, [transfer({ from: W.a3_suspect, to: W.a3_1, amount: 8000, asset: 'USDT', hoursAfterBase: 1 })]);
add(W.a3_1, [transfer({ from: W.a3_1, to: W.a3_2, amount: 7900, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.a3_2, [transfer({ from: W.a3_2, to: W.a3_3, amount: 7800, asset: 'USDT', hoursAfterBase: 3 })]);
add(W.a3_3, [transfer({ from: W.a3_3, to: W.a3_4, amount: 7700, asset: 'USDT', hoursAfterBase: 4 })]);
add(W.a3_4, [transfer({ from: W.a3_4, to: W.a3_5, amount: 7600, asset: 'USDT', hoursAfterBase: 5 })]);
add(W.a3_5, [transfer({ from: W.a3_5, to: W.a3_6, amount: 7500, asset: 'USDT', hoursAfterBase: 6 })]);
add(W.a3_6, [transfer({ from: W.a3_6, to: W.a3_7, amount: 7400, asset: 'USDT', hoursAfterBase: 7 })]);
add(W.a3_7, [transfer({ from: W.a3_7, to: W.okx, amount: 7300, asset: 'USDT', hoursAfterBase: 8 })]);

add(W.a4_suspect, [transfer({ from: W.a4_suspect, to: W.a4_hop1, amount: 500, asset: 'USDT', hoursAfterBase: 1 })]);
add(W.a4_hop1, [transfer({ from: W.a4_hop1, to: W.a4_hop2, amount: 500, asset: 'USDT', hoursAfterBase: 2 })]);
// a4_hop2 never sends anywhere (negative case)

// ============================================================================
// GROUP B — Layering / peeling techniques
// ============================================================================
add(W.b1_suspect, [
  transfer({ from: W.b1_suspect, to: W.layer1A, amount: 18000, asset: 'USDT', hoursAfterBase: 0 }),
  transfer({ from: W.b1_suspect, to: W.layer1B, amount: 15500, asset: 'USDT', hoursAfterBase: 1.5 }),
  transfer({ from: W.b1_suspect, to: W.layer1C, amount: 14200, asset: 'USDT', hoursAfterBase: 2.25 }),
  transfer({ from: W.b1_suspect, to: W.gasFeeder, amount: 0.4, asset: 'ETH', hoursAfterBase: 0.2 }),
  transfer({ from: W.b1_suspect, to: W.dustDecoy, amount: 0.0002, asset: 'ETH', hoursAfterBase: 0.3 }),
]);
add(W.layer1A, [
  transfer({ from: W.layer1A, to: W.layer2A, amount: 17800, asset: 'USDT', hoursAfterBase: 6 }),
  transfer({ from: W.layer1A, to: W.gasFeeder, amount: 0.05, asset: 'ETH', hoursAfterBase: 6.1 }),
]);
add(W.layer1B, [transfer({ from: W.layer1B, to: W.layer2A, amount: 15200, asset: 'USDT', hoursAfterBase: 8.5 })]);
add(W.layer1C, [transfer({ from: W.layer1C, to: W.layer2B, amount: 14000, asset: 'USDT', hoursAfterBase: 9.75 })]);
add(W.layer2A, [
  transfer({ from: W.layer2A, to: W.binance14, amount: 32500, asset: 'USDT', hoursAfterBase: 20 }),
  transfer({ from: W.layer2A, to: W.layer1A, amount: 100, asset: 'USDT', hoursAfterBase: 21 }),
]);
add(W.layer2B, [transfer({ from: W.layer2B, to: W.coinbase10, amount: 13800, asset: 'USDT', hoursAfterBase: 26 })]);
add(W.gasFeeder, [transfer({ from: W.gasFeeder, to: W.dustDecoy, amount: 0.12, asset: 'ETH', hoursAfterBase: 30 })]);

add(W.b2_suspect, [
  transfer({ from: W.b2_suspect, to: W.b2_m1, amount: 2000, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.b2_suspect, to: W.b2_m2, amount: 2000, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.b2_suspect, to: W.b2_m3, amount: 2000, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.b2_suspect, to: W.b2_m4, amount: 2000, asset: 'USDT', hoursAfterBase: 1 }),
]);
add(W.b2_m1, [transfer({ from: W.b2_m1, to: W.binance14, amount: 2000, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b2_m2, [transfer({ from: W.b2_m2, to: W.binance14, amount: 2000, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b2_m3, [transfer({ from: W.b2_m3, to: W.binance14, amount: 2000, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b2_m4, [transfer({ from: W.b2_m4, to: W.binance14, amount: 2000, asset: 'USDT', hoursAfterBase: 2 })]);

add(W.b3_suspect, [
  transfer({ from: W.b3_suspect, to: W.b3_m1, amount: 2500, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.b3_suspect, to: W.b3_m2, amount: 2500, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.b3_suspect, to: W.b3_m3, amount: 2500, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.b3_suspect, to: W.b3_m4, amount: 2500, asset: 'USDT', hoursAfterBase: 1 }),
]);
add(W.b3_m1, [transfer({ from: W.b3_m1, to: W.b3_recon, amount: 2500, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b3_m2, [transfer({ from: W.b3_m2, to: W.b3_recon, amount: 2500, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b3_m3, [transfer({ from: W.b3_m3, to: W.b3_recon, amount: 2500, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b3_m4, [transfer({ from: W.b3_m4, to: W.b3_recon, amount: 2500, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.b3_recon, [transfer({ from: W.b3_recon, to: W.kraken, amount: 10000, asset: 'USDT', hoursAfterBase: 4 })]);

// ============================================================================
// GROUP C — Structuring / smurfing
// ============================================================================
add(W.c1_suspect, [
  transfer({ from: W.c1_suspect, to: W.c1_m1, amount: 9500, asset: 'USDT', hoursAfterBase: 1 }),
  transfer({ from: W.c1_suspect, to: W.c1_m2, amount: 9800, asset: 'USDT', hoursAfterBase: 1.5 }),
  transfer({ from: W.c1_suspect, to: W.c1_m3, amount: 9900, asset: 'USDT', hoursAfterBase: 2 }),
  transfer({ from: W.c1_suspect, to: W.c1_m4, amount: 9750, asset: 'USDT', hoursAfterBase: 2.5 }),
  transfer({ from: W.c1_suspect, to: W.c1_m5, amount: 9600, asset: 'USDT', hoursAfterBase: 3 }),
]);
add(W.c1_m1, [transfer({ from: W.c1_m1, to: W.binance14, amount: 9500, asset: 'USDT', hoursAfterBase: 4 })]);
add(W.c1_m2, [transfer({ from: W.c1_m2, to: W.coinbase10, amount: 9800, asset: 'USDT', hoursAfterBase: 4.5 })]);
add(W.c1_m3, [transfer({ from: W.c1_m3, to: W.okx, amount: 9900, asset: 'USDT', hoursAfterBase: 5 })]);
add(W.c1_m4, [transfer({ from: W.c1_m4, to: W.kraken, amount: 9750, asset: 'USDT', hoursAfterBase: 5.5 })]);
add(W.c1_m5, [transfer({ from: W.c1_m5, to: W.binance14, amount: 9600, asset: 'USDT', hoursAfterBase: 6 })]);

// ============================================================================
// GROUP D — Mixer interaction
// ============================================================================
add(W.d1_suspect, [
  transfer({ from: W.d1_suspect, to: W.tornadoCash10ETH, amount: 10, asset: 'ETH', hoursAfterBase: 1 }),
  transfer({ from: W.d1_suspect, to: W.tornadoCash10ETH, amount: 10, asset: 'ETH', hoursAfterBase: 2 }),
]);
add(W.tornadoCash10ETH, [
  // Simulating mixer withdrawal
  transfer({ from: W.tornadoCash10ETH, to: W.d1_withdrawer, amount: 9.9, asset: 'ETH', hoursAfterBase: 10 }),
]);
add(W.d1_withdrawer, [
  transfer({ from: W.d1_withdrawer, to: W.binance14, amount: 9.8, asset: 'ETH', hoursAfterBase: 11 }),
]);

add(W.d2_suspect, [
  transfer({ from: W.d2_suspect, to: W.tornadoCash10ETH, amount: 10, asset: 'ETH', hoursAfterBase: 1 }),
  transfer({ from: W.d2_suspect, to: W.d2_sloppy, amount: 1.5, asset: 'ETH', hoursAfterBase: 1 }), // Sloppy transfer
]);
add(W.d2_sloppy, [
  transfer({ from: W.d2_sloppy, to: W.coinbase10, amount: 1.5, asset: 'ETH', hoursAfterBase: 2 }),
]);

// ============================================================================
// GROUP E — DEX swap continuation
// ============================================================================
add(W.e1_suspect, [
  transfer({ from: W.e1_suspect, to: W.uniswapV2Router, amount: 5, asset: 'ETH', hoursAfterBase: 1 })
]);
add(W.uniswapV2Router, [
  transfer({ from: W.uniswapV2Router, to: W.e1_postSwap, amount: 15000, asset: 'USDT', hoursAfterBase: 1 })
]);
add(W.e1_postSwap, [
  transfer({ from: W.e1_postSwap, to: W.binance14, amount: 15000, asset: 'USDT', hoursAfterBase: 2 })
]);

add(W.e2_suspect, [
  transfer({ from: W.e2_suspect, to: W.uniswapV3Router, amount: 10, asset: 'ETH', hoursAfterBase: 1 })
]);
add(W.uniswapV3Router, [
  transfer({ from: W.uniswapV3Router, to: W.e2_postSwap1, amount: 30000, asset: 'USDT', hoursAfterBase: 1 })
]);
add(W.e2_postSwap1, [
  transfer({ from: W.e2_postSwap1, to: W.uniswapV2Router, amount: 30000, asset: 'USDT', hoursAfterBase: 2 })
]);
add(W.uniswapV2Router, [
  // Swapped to DAI, assuming we have DAI. We'll use USDC or DAI equivalent here. 
  // Wait, asset config uses USDT. We'll simulate a wrap/unwrap or cross pair. Let's just use USDT.
  transfer({ from: W.uniswapV2Router, to: W.e2_postSwap2, amount: 29900, asset: 'USDT', hoursAfterBase: 2 })
]);
add(W.e2_postSwap2, [
  transfer({ from: W.e2_postSwap2, to: W.kraken, amount: 29900, asset: 'USDT', hoursAfterBase: 3 })
]);

// ============================================================================
// GROUP F — Cross-chain bridge
// ============================================================================
add(W.f1_suspect, [
  transfer({ from: W.f1_suspect, to: W.polygonPoSBridge, amount: 50000, asset: 'USDT', hoursAfterBase: 1 }),
]);
add(W.polygonPoSBridge, [
  transfer({ from: W.polygonPoSBridge, to: W.f1_poly1, amount: 50000, asset: 'USDT', hoursAfterBase: 2 }),
]);
add(W.f1_poly1, [
  transfer({ from: W.f1_poly1, to: W.f1_poly2, amount: 49900, asset: 'USDT', hoursAfterBase: 3 }),
]);
add(W.f1_poly2, [
  transfer({ from: W.f1_poly2, to: W.binance14, amount: 49800, asset: 'USDT', hoursAfterBase: 4 }), // Reaches exchange
]);

// ============================================================================
// GROUP G — Combined / adversarial
// ============================================================================
add(W.g1_suspect, [
  transfer({ from: W.g1_suspect, to: W.g1_p1, amount: 50000, asset: 'USDT', hoursAfterBase: 1 })
]);
add(W.g1_p1, [
  transfer({ from: W.g1_p1, to: W.uniswapV3Router, amount: 10, asset: 'ETH', hoursAfterBase: 2 })
]);
add(W.uniswapV3Router, [
  transfer({ from: W.uniswapV3Router, to: W.g1_postSwap, amount: 30000, asset: 'USDT', hoursAfterBase: 2 })
]);
add(W.g1_postSwap, [
  transfer({ from: W.g1_postSwap, to: W.tornadoCash10ETH, amount: 10, asset: 'ETH', hoursAfterBase: 3 })
]);
add(W.tornadoCash10ETH, [
  transfer({ from: W.tornadoCash10ETH, to: W.g1_withdrawer, amount: 9.9, asset: 'ETH', hoursAfterBase: 10 })
]);
add(W.g1_withdrawer, [
  transfer({ from: W.g1_withdrawer, to: W.polygonPoSBridge, amount: 9.9, asset: 'ETH', hoursAfterBase: 11 })
]);
add(W.polygonPoSBridge, [
  transfer({ from: W.polygonPoSBridge, to: W.g1_poly1, amount: 9.9, asset: 'ETH', hoursAfterBase: 12 })
]);
add(W.g1_poly1, [
  transfer({ from: W.g1_poly1, to: W.okx, amount: 9.8, asset: 'ETH', hoursAfterBase: 13 })
]);

// G2: High fan-out stress case (MAX_FANOUT_PER_ADDRESS circuit breaker tester)
const g2_txs = [];
for (let i = 0; i < 25; i++) {
  const recipient = synthAddress(`g2-dust-${i}`);
  g2_txs.push(transfer({ from: W.g2_suspect, to: recipient, amount: 100, asset: 'USDT', hoursAfterBase: 1 + (i * 0.1) }));
  // Give just one of them a path to an exchange so the trace succeeds but only if it's not pruned
  if (i === 1) {
    add(recipient, [transfer({ from: recipient, to: W.binance14, amount: 100, asset: 'USDT', hoursAfterBase: 5 })]);
  }
}
add(W.g2_suspect, g2_txs);

// ============================================================================
// GROUP H — Fraud Typologies
// ============================================================================
add(W.h1_suspect, [
  transfer({ from: W.h1_suspect, to: W.binance14, amount: 500, asset: 'USDT', hoursAfterBase: 0.1 })
]);
add(W.h2_suspect, [
  transfer({ from: W.h2_suspect, to: W.okx, amount: 250000, asset: 'USDT', hoursAfterBase: 2 })
]);
add(W.h3_victim1, [transfer({ from: W.h3_victim1, to: W.h3_suspect, amount: 100, asset: 'USDT', hoursAfterBase: 1 })]);
add(W.h3_victim2, [transfer({ from: W.h3_victim2, to: W.h3_suspect, amount: 200, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.h3_victim3, [transfer({ from: W.h3_victim3, to: W.h3_suspect, amount: 150, asset: 'USDT', hoursAfterBase: 3 })]);
add(W.h3_suspect, [transfer({ from: W.h3_suspect, to: W.kraken, amount: 450, asset: 'USDT', hoursAfterBase: 5 })]);

add(W.h4_victim1, [transfer({ from: W.h4_victim1, to: W.h4_suspect, amount: 50, asset: 'USDT', hoursAfterBase: 24 })]);
add(W.h4_victim2, [transfer({ from: W.h4_victim2, to: W.h4_suspect, amount: 50, asset: 'USDT', hoursAfterBase: 72 })]);
add(W.h4_suspect, [transfer({ from: W.h4_suspect, to: W.binance14, amount: 100, asset: 'USDT', hoursAfterBase: 96 })]);

// ============================================================================
// GROUP I — Cross-case correlation
// ============================================================================
add(W.i_vic1, [transfer({ from: W.i_vic1, to: W.i_shared, amount: 1000, asset: 'USDT', hoursAfterBase: 1 })]);
add(W.i_vic2, [transfer({ from: W.i_vic2, to: W.i_shared, amount: 1000, asset: 'USDT', hoursAfterBase: 2 })]);
add(W.i_shared, [
  transfer({ from: W.i_shared, to: W.i_out1, amount: 1000, asset: 'USDT', hoursAfterBase: 4 }),
  transfer({ from: W.i_shared, to: W.i_out2, amount: 1000, asset: 'USDT', hoursAfterBase: 4 })
]);
add(W.i_out1, [transfer({ from: W.i_out1, to: W.binance14, amount: 1000, asset: 'USDT', hoursAfterBase: 5 })]);
add(W.i_out2, [transfer({ from: W.i_out2, to: W.coinbase10, amount: 1000, asset: 'USDT', hoursAfterBase: 5 })]);


const scenarios = [
  { id: 'A1', name: 'Direct 1-hop cash-out', suspect: W.a1_suspect, fraudType: 'investment_scam' },
  { id: 'A2', name: 'Simple 3-hop chain', suspect: W.a2_suspect, fraudType: 'investment_scam' },
  { id: 'A3', name: 'Deep 8-hop chain', suspect: W.a3_suspect, fraudType: 'investment_scam' },
  { id: 'A4', name: 'NEGATIVE CASE: No route', suspect: W.a4_suspect, fraudType: 'investment_scam' },
  { id: 'B1', name: 'Classic peeling chain', suspect: W.b1_suspect, fraudType: 'task_based_fraud' },
  { id: 'B2', name: 'Fan-out layering', suspect: W.b2_suspect, fraudType: 'investment_scam' },
  { id: 'B3', name: 'Fan-out then reconsolidation', suspect: W.b3_suspect, fraudType: 'investment_scam' },
  { id: 'C1', name: 'Structuring / Smurfing', suspect: W.c1_suspect, fraudType: 'investment_scam' },
  { id: 'D1', name: 'Mixer hit (Tornado Cash)', suspect: W.d1_suspect, fraudType: 'darknet_transaction' },
  { id: 'D2', name: 'Mixer with sloppy direct link', suspect: W.d2_suspect, fraudType: 'darknet_transaction' },
  { id: 'E1', name: 'DEX swap continuation', suspect: W.e1_suspect, fraudType: 'investment_scam' },
  { id: 'E2', name: 'Double DEX swap', suspect: W.e2_suspect, fraudType: 'investment_scam' },
  { id: 'F1', name: 'Cross-chain bridge', suspect: W.f1_suspect, fraudType: 'investment_scam' },
  { id: 'G1', name: 'Kitchen sink (Peel->Swap->Mix->Bridge)', suspect: W.g1_suspect, fraudType: 'investment_scam' },
  { id: 'G2', name: 'Dust-attack / high fan-out', suspect: W.g2_suspect, fraudType: 'investment_scam' },
  { id: 'H1', name: 'Sextortion', suspect: W.h1_suspect, fraudType: 'sextortion' },
  { id: 'H2', name: 'Ransomware', suspect: W.h2_suspect, fraudType: 'ransomware' },
  { id: 'H3', name: 'Phishing', suspect: W.h3_victim1, fraudType: 'phishing' },
  { id: 'H4', name: 'Task-based fraud', suspect: W.h4_victim1, fraudType: 'task_based_fraud' },
  { id: 'I1', name: 'Cross-case Vic 1', suspect: W.i_vic1, fraudType: 'investment_scam' },
  { id: 'I2', name: 'Cross-case Vic 2', suspect: W.i_vic2, fraudType: 'task_based_fraud' }
];

const payload = {
  network: 'eth-mainnet',
  generatedAt: new Date().toISOString(),
  generator: 'scripts/generate-fixtures.js',
  scenario: '25 Comprehensive Scenarios (Groups A-I)',
  transfersByAddress,
  scenarios,
  participants: {
    suspect: W.b1_suspect, // Map back to original suspect for smoke.js
    hop1: [W.layer1A, W.layer1B, W.layer1C],
    hop2: [W.layer2A, W.layer2B],
    exchanges: [W.binance14, W.coinbase10],
    sideBranch: [W.gasFeeder, W.dustDecoy]
  }
};

await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`Wrote ${path.relative(PACKAGE_ROOT, OUTPUT_FILE)}`);
console.log('');
console.log('--- TEST CASES ---');
for (const s of scenarios) {
  console.log(`${s.id.padEnd(4)} ${s.suspect} (${s.fraudType}) - ${s.name}`);
}
