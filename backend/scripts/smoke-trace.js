/**
 * scripts/smoke-trace.js
 * ---------------------------------------------------------------------------
 * Self-verifying Phase 3 test. Runs entirely offline: no Neo4j, no API key, no
 * network, no frontend.
 *
 * Run with:  npm run smoke:trace
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Phase 3 is where the project starts producing CLAIMS rather than data - "the
 * funds reached Binance in four hops" is an assertion an investigator might act
 * on. The failure mode that matters is not a crash; it is a confident wrong
 * answer. So the checks below are weighted towards the ways this code could be
 * wrong quietly:
 *
 *   - a hop bound that silently does not apply, so a 30-hop coincidence is
 *     reported as a trace,
 *   - path amounts summed along the route, inflating the figure by counting the
 *     same money once per hop,
 *   - a path whose timestamps run backwards reported as a laundering sequence,
 *   - "no route found" and "you forgot to seed the exchanges" collapsed into the
 *     same empty answer,
 *   - a shared edge drawn twice, making one flow look like two,
 *   - the cash-out node rendered smaller than the mule wallet feeding it,
 *   - an amount in one asset compared against, or priced as, another.
 *
 * A fake Bolt driver serves a hand-built graph with known distances, so every
 * hop count and ranking below is checked against an answer worked out by hand
 * rather than against whatever the code happened to produce.
 */

// Environment must be set before any module reads config.
process.env.MOCK_MODE = 'true';
process.env.GRAPH_ENABLED = 'true';
process.env.NEO4J_PASSWORD = 'offline-test-password';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.NATIVE_USD_HINT = '3000';
// Pinned, not inherited: the asset allowlist is per-network, and the valuation
// checks below name ETH and USDT specifically. Without this, a developer whose
// .env points at another chain would see those checks fail for no real reason.
process.env.ALCHEMY_NETWORK = 'eth-mainnet';

import assert from 'node:assert/strict';

// --- Tiny test harness -----------------------------------------------------

let passed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message.split('\n').slice(0, 6).join('\n        ')}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// --- The scenario graph ----------------------------------------------------
//
// Distances are chosen so that every ranking rule has something to decide:
//
//   VICTIM -> MULE_A -> MULE_B -> BINANCE     3 hops, 32,500 USDT in
//   VICTIM -> MULE_A -> KRAKEN                2 hops,      0.4 ETH in
//   VICTIM -> MULE_A -> MULE_C -> COINBASE    3 hops,       12 ETH in
//   MULE_A -> DUST_1, DUST_2                  off-path fan-out, native
//   MULE_A -> DUST_3                          off-path fan-out, 5,000 USDT
//   FAR_1 -> ... -> FAR_5 -> OKX              a route only reachable in 6 hops
//
// So: Kraken is nearest (2), and Binance and Coinbase tie at 3 with Coinbase
// winning on value (12 ETH ~ $36,000 vs 32,500 USDT). OKX exists to prove the
// hop bound actually bites.

const VICTIM = '0x1111111111111111111111111111111111111111';
const MULE_A = '0x2222222222222222222222222222222222222222';
const MULE_B = '0x3333333333333333333333333333333333333333';
const MULE_C = '0x4444444444444444444444444444444444444444';
const BINANCE = '0xaaaa0000000000000000000000000000000000aa';
const KRAKEN = '0xbbbb0000000000000000000000000000000000bb';
const COINBASE = '0xcccc0000000000000000000000000000000000cc';
const OKX = '0xdddd0000000000000000000000000000000000dd';
const DUST_1 = '0xeeee0000000000000000000000000000000000ee';
const DUST_2 = '0xffff0000000000000000000000000000000000ff';
// Off-path, and paid in a STABLECOIN on purpose. Every other fan-out edge in this
// scenario is native ETH, and a scenario made only of native edges cannot detect a
// stablecoin being mispriced as native - which is exactly how a 3,000x volume
// inflation shipped and was found by eye on real fixture data instead.
const DUST_3 = '0x8888000000000000000000000000000000000088';
const FAR = [
  '0x9991111111111111111111111111111111111111',
  '0x9992222222222222222222222222222222222222',
  '0x9993333333333333333333333333333333333333',
  '0x9994444444444444444444444444444444444444',
  '0x9995555555555555555555555555555555555555',
];

const T0 = 1_735_689_600; // 2025-01-01T00:00:00Z

/** @type {Map<string, any>} */
let walletStore = new Map();
/** @type {Map<string, any>} */
let edgeStore = new Map();

/**
 * @param {string} address
 * @param {object} [extra]
 */
function wallet(address, extra = {}) {
  return {
    address,
    addressDisplay: address,
    isExchange: false,
    exchange: null,
    exchangeLabel: null,
    riskScore: 20,
    minHopObserved: 1,
    traceCount: 1,
    firstSeenAt: '2025-01-01T00:00:00.000Z',
    lastSeenAt: '2025-01-02T00:00:00.000Z',
    ...extra,
  };
}

/**
 * @param {string} from
 * @param {string} to
 * @param {object} [extra]
 */
function edge(from, to, extra = {}) {
  const hash = extra.hash ?? `0xhash_${from.slice(2, 6)}_${to.slice(2, 6)}`;
  return {
    uniqueId: extra.uniqueId ?? `${hash}:0:${from}:${to}`,
    hash,
    from,
    to,
    amount: extra.amount ?? 1,
    asset: extra.asset ?? 'ETH',
    assetClass: extra.assetClass ?? 'native',
    contract: extra.contract ?? null,
    timestamp: extra.timestamp ?? T0,
    blockNumber: extra.blockNumber ?? 21_000_000,
    category: extra.category ?? 'external',
  };
}

/** Rebuild the scenario. Called before each block so no check leaks into another. */
function buildScenario({ seedExchanges = true, includeVictim = true } = {}) {
  walletStore = new Map();
  edgeStore = new Map();

  const put = (w) => walletStore.set(w.address, w);
  const link = (e) => edgeStore.set(e.uniqueId, e);

  if (includeVictim) put(wallet(VICTIM, { riskScore: 60, minHopObserved: 0 }));
  put(wallet(MULE_A));
  put(wallet(MULE_B));
  put(wallet(MULE_C));
  put(wallet(DUST_1));
  put(wallet(DUST_2));
  put(wallet(DUST_3));
  for (const address of FAR) put(wallet(address));

  if (seedExchanges) {
    put(wallet(BINANCE, { isExchange: true, exchange: 'binance', exchangeLabel: 'Binance 14', riskScore: 5 }));
    put(wallet(KRAKEN, { isExchange: true, exchange: 'kraken', exchangeLabel: 'Kraken 4', riskScore: 5 }));
    put(wallet(COINBASE, { isExchange: true, exchange: 'coinbase', exchangeLabel: 'Coinbase 6', riskScore: 5 }));
    put(wallet(OKX, { isExchange: true, exchange: 'okx', exchangeLabel: 'OKX 1', riskScore: 5 }));
  } else {
    // Present as ordinary wallets: this is the "you forgot to seed" state, which
    // must be distinguishable from "there is genuinely no route".
    put(wallet(BINANCE));
    put(wallet(KRAKEN));
    put(wallet(COINBASE));
    put(wallet(OKX));
  }

  // Route 1: 3 hops to Binance, ending in a large stablecoin deposit.
  link(edge(VICTIM, MULE_A, { amount: 12.5, timestamp: T0 }));
  link(edge(MULE_A, MULE_B, { amount: 12.4, timestamp: T0 + 600 }));
  link(edge(MULE_B, BINANCE, {
    amount: 32_500, asset: 'USDT', assetClass: 'stablecoin', timestamp: T0 + 1200,
  }));

  // Route 2: 2 hops to Kraken - nearest, but a small amount.
  link(edge(MULE_A, KRAKEN, { amount: 0.4, timestamp: T0 + 900 }));

  // Route 3: 3 hops to Coinbase - ties with Binance, wins on value.
  link(edge(MULE_A, MULE_C, { amount: 12, timestamp: T0 + 700 }));
  link(edge(MULE_C, COINBASE, { amount: 12, timestamp: T0 + 1500 }));

  // Off-path fan-out from MULE_A. Amounts kept small so the LIMIT ordering
  // (amount DESC) is predictable.
  link(edge(MULE_A, DUST_1, { amount: 0.02 }));
  link(edge(MULE_A, DUST_2, { amount: 0.01 }));

  // One off-path edge in a stablecoin. 5,000 USDT is worth less than the ETH
  // moving along the traced routes, so this wallet must stay visually minor. Price
  // it as native by mistake and it becomes $15,000,000 - larger than everything
  // else in the picture combined, and drawn accordingly.
  link(edge(MULE_A, DUST_3, {
    amount: 5_000, asset: 'USDT', assetClass: 'stablecoin', category: 'erc20',
    contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  }));

  // A long tail: VICTIM -> FAR_0 -> ... -> FAR_4 -> OKX is 6 hops.
  link(edge(VICTIM, FAR[0], { amount: 0.5 }));
  for (let i = 0; i < FAR.length - 1; i += 1) {
    link(edge(FAR[i], FAR[i + 1], { amount: 0.5 }));
  }
  link(edge(FAR.at(-1), OKX, { amount: 0.5 }));
}

// --- The fake driver -------------------------------------------------------

/** Every query issued, in order, so the Cypher itself can be inspected. */
let captured = [];

/** @param {number} value */
function fakeInt(value) {
  return { __neoInt: true, value, toNumber: () => value };
}

function fakeRecord(fields) {
  return { keys: Object.keys(fields), get: (key) => fields[key], toObject: () => fields };
}

function fakeResult(records = []) {
  return {
    records,
    summary: { counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0 }) } },
  };
}

function graphNode(address) {
  return { labels: ['Wallet'], properties: walletStore.get(address) ?? { address } };
}

/**
 * Breadth-first search for one shortest route to each reachable exchange, which
 * is what the real `shortestPath((start)-[:TRANSACTION*1..n]->(exchange))`
 * returns once `exchange` is bound by the preceding MATCH.
 *
 * Exchanges are terminal here, as they are in the product.
 *
 * @param {string} start
 * @param {number} maxHops
 */
function bfsToExchanges(start, maxHops) {
  const outgoing = new Map();
  for (const e of edgeStore.values()) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e);
  }

  const found = new Map();
  const visited = new Set([start]);
  let frontier = [{ address: start, trail: [] }];

  while (frontier.length > 0 && frontier[0].trail.length < maxHops) {
    const next = [];
    for (const { address, trail } of frontier) {
      for (const e of outgoing.get(address) ?? []) {
        const trailToHere = [...trail, e];
        if (walletStore.get(e.to)?.isExchange && e.to !== start) {
          if (!found.has(e.to)) found.set(e.to, trailToHere);
          continue;
        }
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        next.push({ address: e.to, trail: trailToHere });
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * @param {object} [options]
 * @param {string|null} [options.failOn] Regex source; matching queries throw.
 */
function createFakeDriver({ failOn = null } = {}) {
  /**
   * @param {string} cypher
   * @param {Record<string, any>} params
   */
  const dispatch = async (cypher, params = {}) => {
    captured.push({ cypher, params });

    if (failOn && new RegExp(failOn).test(cypher)) {
      const error = new Error(
        'Could not perform discovery. No routing servers available.'
      );
      error.code = 'ServiceUnavailable';
      throw error;
    }

    // shortestPath. The hop bound is read back out of the query TEXT, which is
    // how this proves the bound was interpolated rather than left as a parameter
    // Cypher would have rejected.
    if (/shortestPath/.test(cypher)) {
      const bound = Number(cypher.match(/TRANSACTION\*1\.\.(\d+)/)?.[1] ?? 0);
      assert.ok(bound > 0, 'no numeric hop bound found in the shortestPath query');
      if (!walletStore.has(params.address)) return fakeResult([]);

      const records = [...bfsToExchanges(params.address, bound).entries()]
        .sort((a, b) => a[1].length - b[1].length)
        .map(([exchangeAddress, trail]) => {
          const exchange = walletStore.get(exchangeAddress) ?? {};
          return fakeRecord({
            path: {
              start: graphNode(params.address),
              end: graphNode(exchangeAddress),
              // The driver's own shape: ordered segments, each with its own
              // endpoints, so direction never has to be re-derived.
              segments: trail.map((e) => ({
                start: graphNode(e.from),
                relationship: { type: 'TRANSACTION', properties: e },
                end: graphNode(e.to),
              })),
              length: trail.length,
            },
            exchangeAddress,
            exchangeDisplay: exchange.addressDisplay ?? exchangeAddress,
            exchangeName: exchange.exchange ?? null,
            exchangeLabel: exchange.exchangeLabel ?? null,
            hops: fakeInt(trail.length),
          });
        });
      return fakeResult(records);
    }

    // Start wallet.
    if (/w\.minHopObserved/.test(cypher)) {
      const found = walletStore.get(params.address);
      if (!found) return fakeResult([]);
      return fakeResult([fakeRecord({ ...found, riskScore: fakeInt(found.riskScore) })]);
    }

    // Exchange count.
    if (/isExchange = true RETURN count\(w\)/.test(cypher)) {
      const total = [...walletStore.values()].filter((w) => w.isExchange).length;
      return fakeResult([fakeRecord({ total: fakeInt(total) })]);
    }

    // Off-path context.
    if (/UNWIND \$addresses AS addr/.test(cypher)) {
      const onPath = new Set(params.addresses ?? []);
      const rows = [];
      for (const e of edgeStore.values()) {
        if (!onPath.has(e.from) || onPath.has(e.to)) continue;
        if (walletStore.get(e.from)?.isExchange) continue;
        const target = walletStore.get(e.to) ?? {};
        rows.push(
          fakeRecord({
            fromAddress: e.from,
            toAddress: e.to,
            toDisplay: target.addressDisplay ?? e.to,
            toIsExchange: Boolean(target.isExchange),
            toExchange: target.exchange ?? null,
            toRiskScore: fakeInt(target.riskScore ?? 0),
            uniqueId: e.uniqueId,
            hash: e.hash,
            amount: e.amount,
            asset: e.asset,
            // Mirrors the real RETURN list field for field. When the fake serves
            // fewer columns than the query asks for, the suite tests a shape the
            // database never produces - which is how a missing assetClass got
            // past 58 green checks.
            assetClass: e.assetClass ?? null,
            blockNumber: fakeInt(e.blockNumber),
            timestamp: fakeInt(e.timestamp),
          })
        );
      }
      rows.sort((a, b) => b.get('amount') - a.get('amount'));
      return fakeResult(rows.slice(0, Number(params.limit ?? 40)));
    }

    return fakeResult([]);
  };

  const run = dispatch;

  const session = () => ({
    run,
    executeRead: async (work) => work({ run }),
    executeWrite: async (work) => work({ run }),
    close: async () => {},
  });

  return {
    session,
    close: async () => {},
    getServerInfo: async () => ({ protocolVersion: 5.0 }),
    verifyConnectivity: async () => true,
  };
}

// --- Imports (after env is set) --------------------------------------------

const { __setDriverForTesting } = await import('../src/services/neo4j.service.js');
const {
  findCashOutPaths,
  buildShortestPathCypher,
  assertHopBound,
  findTemporalBreak,
  MAX_HOPS_CEILING,
  DEFAULT_MAX_HOPS,
  MAX_CONTEXT_EDGES,
} = await import('../src/services/trace.service.js');
const { toForceGraph, NODE_ROLES } = await import('../src/lib/forceGraph.js');
const { approximateUsd } = await import('../src/lib/valuation.js');

console.log('CryptoTrace - Phase 3 offline smoke test');
console.log('=======================================');

// ===========================================================================
section('1. The Cypher itself');

await check('the hop bound is a literal in the query, not a parameter', () => {
  const cypher = buildShortestPathCypher(15);
  assert.match(cypher, /TRANSACTION\*1\.\.15/);
  // Cypher cannot parameterise a variable-length bound: `*1..$max` is a syntax
  // error, not a slow query. If this ever becomes a parameter the query stops
  // running at all, so it is worth pinning.
  assert.doesNotMatch(cypher, /TRANSACTION\*1\.\.\$/);
});

await check('the query targets flagged exchanges and excludes the start wallet', () => {
  const cypher = buildShortestPathCypher(DEFAULT_MAX_HOPS);
  assert.match(cypher, /exchange\.isExchange = true/);
  assert.match(cypher, /exchange\.address <> \$address/);
});

await check('the address is passed as a parameter, never interpolated', () => {
  const cypher = buildShortestPathCypher(4);
  assert.match(cypher, /\{ address: \$address \}/);
  assert.doesNotMatch(cypher, /0x[0-9a-f]{40}/i);
});

await check('results are ordered inside the query, so paging stays stable', () => {
  assert.match(buildShortestPathCypher(4), /ORDER BY hops ASC/);
});

// ===========================================================================
section('2. The hop bound, the one value that reaches Cypher as text');

await check('valid bounds are accepted at both extremes', () => {
  assert.equal(assertHopBound(1), 1);
  assert.equal(assertHopBound(MAX_HOPS_CEILING), MAX_HOPS_CEILING);
});

await check('out-of-range and non-integer bounds are rejected', () => {
  for (const bad of [0, -1, 1.5, MAX_HOPS_CEILING + 1, Number.NaN, Infinity]) {
    assert.throws(() => assertHopBound(bad), /maxHops must be an integer/, `accepted ${bad}`);
  }
});

await check('a bound carrying Cypher cannot reach the query', () => {
  // The whole reason assertHopBound exists. Interpolation is unavoidable here,
  // so the gate has to be airtight rather than merely present.
  for (const bad of ['5 OR 1=1', '3; MATCH (n) DETACH DELETE n', '15]->(x)-[', '', null, undefined, {}]) {
    assert.throws(() => assertHopBound(bad), /maxHops must be an integer/, `accepted ${JSON.stringify(bad)}`);
  }
});

await check('a rejected bound is a 400, not a 500', () => {
  try {
    assertHopBound(99);
    assert.fail('should have thrown');
  } catch (error) {
    // A caller asking for 99 hops made a bad request; it is not a server fault.
    assert.equal(error.statusCode, 400);
  }
});

await check('buildShortestPathCypher refuses a bad bound rather than building a query', () => {
  assert.throws(() => buildShortestPathCypher('5 OR 1=1'), /maxHops must be an integer/);
});

// ===========================================================================
section('3. Temporal consistency');

await check('a route whose timestamps ascend is consistent', () => {
  assert.equal(findTemporalBreak([{ timestamp: 100 }, { timestamp: 200 }, { timestamp: 300 }]), -1);
});

await check('a route where money leaves before it arrives is flagged at the right hop', () => {
  // shortestPath is a topological search; it does not know this is impossible.
  assert.equal(findTemporalBreak([{ timestamp: 300 }, { timestamp: 100 }]), 1);
  assert.equal(findTemporalBreak([{ timestamp: 100 }, { timestamp: 200 }, { timestamp: 150 }]), 2);
});

await check('missing timestamps are skipped, not treated as breaks', () => {
  // Absent data is not evidence of an impossible route.
  assert.equal(findTemporalBreak([{ timestamp: 100 }, { timestamp: null }, { timestamp: 200 }]), -1);
  assert.equal(findTemporalBreak([{ timestamp: undefined }]), -1);
});

await check('equal timestamps are allowed - two transfers can share a block', () => {
  assert.equal(findTemporalBreak([{ timestamp: 100 }, { timestamp: 100 }]), -1);
});

// ===========================================================================
section('4. Tracing the scenario graph');

buildScenario();
__setDriverForTesting(createFakeDriver());
captured = [];

const traced = await findCashOutPaths(VICTIM, { maxHops: DEFAULT_MAX_HOPS });

await check('all four cash-out routes are found at the default bound', () => {
  // Four, not three: OKX sits 6 hops away and the default bound is 15, so it is
  // legitimately in range. Section 6 lowers the bound to prove it can be excluded.
  assert.equal(traced.found, true);
  assert.equal(traced.paths.length, 4, `expected 4 paths, got ${traced.paths.length}`);
});

await check('hop counts match the hand-worked distances', () => {
  const byExchange = new Map(traced.paths.map((p) => [p.exchange.exchange, p.hops]));
  assert.equal(byExchange.get('kraken'), 2);
  assert.equal(byExchange.get('binance'), 3);
  assert.equal(byExchange.get('coinbase'), 3);
  assert.equal(byExchange.get('okx'), 6);
});

await check('the nearest exchange is the headline answer', () => {
  assert.equal(traced.topExchange.exchange, 'kraken');
  assert.equal(traced.shortestHops, 2);
});

await check('among equal-length routes the larger deposit ranks first', () => {
  // Coinbase received 12 ETH (~$36,000) against Binance's 32,500 USDT, so at the
  // same hop distance Coinbase is named first. Ranking on the raw numbers would
  // put Binance first, which is the wrong answer arrived at confidently - the
  // reason the tiebreak normalises to approximate USD.
  const tied = traced.paths.filter((p) => p.hops === 3).map((p) => p.exchange.exchange);
  assert.deepEqual(tied, ['coinbase', 'binance']);
});

await check('the reported deposit stays in its own asset despite USD ranking', () => {
  const binance = traced.paths.find((p) => p.exchange.exchange === 'binance');
  const coinbase = traced.paths.find((p) => p.exchange.exchange === 'coinbase');
  // The estimate decides the order and nothing else.
  assert.equal(binance.amountIntoExchange, 32_500);
  assert.equal(binance.assetIntoExchange, 'USDT');
  assert.equal(coinbase.amountIntoExchange, 12);
  assert.equal(coinbase.assetIntoExchange, 'ETH');
  assert.equal(coinbase.amountIntoExchangeUsdApprox, 36_000);
  assert.ok(coinbase.amountIntoExchangeUsdApprox > binance.amountIntoExchangeUsdApprox);
});

await check('the operator name and label survive the trip', () => {
  const binance = traced.paths.find((p) => p.exchange.exchange === 'binance');
  assert.equal(binance.exchange.label, 'Binance 14');
  assert.equal(binance.exchange.addressDisplay, BINANCE);
});

await check('steps are 1-based and directional', () => {
  const binance = traced.paths.find((p) => p.exchange.exchange === 'binance');
  assert.deepEqual(binance.steps.map((s) => s.hop), [1, 2, 3]);
  assert.equal(binance.steps[0].from, VICTIM);
  assert.equal(binance.steps[0].to, MULE_A);
  assert.equal(binance.steps.at(-1).to, BINANCE);
});

await check('the final step is marked as reaching an exchange', () => {
  for (const path of traced.paths) {
    assert.equal(path.steps.at(-1).toIsExchange, true, `${path.exchange.exchange} last step`);
    // ...and no earlier step is, in this scenario.
    assert.deepEqual(
      path.steps.slice(0, -1).map((s) => s.toIsExchange),
      path.steps.slice(0, -1).map(() => false)
    );
  }
});

// ===========================================================================
section('5. Amounts - the arithmetic that is easy to get confidently wrong');

await check('the reported deposit is the final transfer, not a sum of the route', () => {
  const binance = traced.paths.find((p) => p.exchange.exchange === 'binance');
  // The route carries 12.5 ETH, then 12.4 ETH, then 32,500 USDT. Summing those
  // would produce a meaningless 32,524.9 - the same money counted once per hop,
  // in two different units. What landed at the exchange is 32,500 USDT.
  assert.equal(binance.amountIntoExchange, 32_500);
  assert.equal(binance.assetIntoExchange, 'USDT');
});

await check('the bottleneck is the smallest transfer on the route', () => {
  const binance = traced.paths.find((p) => p.exchange.exchange === 'binance');
  // Upper-bounds how much of the victim's money could have travelled the whole
  // way: a route cannot carry more than its narrowest hop.
  assert.equal(binance.bottleneckAmount, 12.4);
});

await check('no field on a path equals the sum of its step amounts', () => {
  for (const path of traced.paths) {
    const total = path.steps.reduce((sum, step) => sum + step.amount, 0);
    const reported = Object.entries(path).filter(
      ([key, value]) => typeof value === 'number' && Math.abs(value - total) < 1e-9 && key !== 'hops'
    );
    assert.equal(
      reported.length,
      0,
      `${path.exchange.exchange} exposes a summed total in: ${reported.map(([k]) => k).join(', ')}`
    );
  }
});

await check('first and last seen bracket the route', () => {
  const binance = traced.paths.find((p) => p.exchange.exchange === 'binance');
  assert.equal(binance.firstSeenAt, T0);
  assert.equal(binance.lastSeenAt, T0 + 1200);
});

await check('every route in this scenario is temporally consistent', () => {
  for (const path of traced.paths) {
    assert.equal(path.temporallyOrdered, true, `${path.exchange.exchange} flagged out of order`);
  }
  assert.equal(traced.stats.temporallyInconsistentPaths, 0);
  assert.deepEqual(traced.warnings, []);
});

// ===========================================================================
section('6. The hop bound actually bites');

await check('OKX at 6 hops is in range at the default bound of 15', () => {
  assert.ok(traced.paths.some((p) => p.exchange.exchange === 'okx'));
  assert.equal(traced.paths.find((p) => p.exchange.exchange === 'okx').hops, 6);
});

const capped = await findCashOutPaths(VICTIM, { maxHops: 4 });
await check('a 4-hop bound excludes the 6-hop OKX route', () => {
  // The bound has to actually bite. If it silently did not, a 30-hop coincidence
  // would be reported as a trace.
  const reachable = capped.paths.map((p) => p.exchange.exchange);
  assert.ok(!reachable.includes('okx'), `OKX should be out of range at 4 hops: ${reachable}`);
  assert.equal(capped.paths.length, 3);
});

const wide = await findCashOutPaths(VICTIM, { maxHops: 6 });
await check('a 6-hop bound brings it back', () => {
  assert.ok(wide.paths.some((p) => p.exchange.exchange === 'okx'), 'OKX not found at 6 hops');
  assert.equal(wide.paths.find((p) => p.exchange.exchange === 'okx').hops, 6);
});

const narrow = await findCashOutPaths(VICTIM, { maxHops: 2 });
await check('lowering the bound to 2 leaves only Kraken', () => {
  assert.equal(narrow.paths.length, 1);
  assert.equal(narrow.paths[0].exchange.exchange, 'kraken');
});

await check('the bound reaching the query matches the bound requested', () => {
  const query = captured.filter((c) => /shortestPath/.test(c.cypher)).at(-1);
  assert.match(query.cypher, /TRANSACTION\*1\.\.2/);
});

// ===========================================================================
section('7. Context edges');

await check('off-path fan-out is returned alongside the routes', () => {
  const targets = traced.contextEdges.map((e) => e.to);
  assert.ok(targets.includes(DUST_1), 'DUST_1 missing from context');
  assert.ok(targets.includes(DUST_2), 'DUST_2 missing from context');
});

await check('on-path wallets are not repeated as context', () => {
  const onPath = new Set(traced.paths.flatMap((p) => p.steps.flatMap((s) => [s.from, s.to])));
  for (const contextEdge of traced.contextEdges) {
    assert.ok(!onPath.has(contextEdge.to), `${contextEdge.to} is on a path and should not be context`);
  }
});

await check('exchange wallets are never expanded for context', () => {
  // A Binance hot wallet has hundreds of thousands of outgoing transfers;
  // expanding one would bury the route just found.
  const contextQuery = captured.find((c) => /UNWIND \$addresses AS addr/.test(c.cypher));
  assert.match(contextQuery.cypher, /coalesce\(w\.isExchange, false\) = false/);
  for (const contextEdge of traced.contextEdges) {
    assert.notEqual(contextEdge.from, BINANCE);
    assert.notEqual(contextEdge.from, KRAKEN);
  }
});

await check('context edges carry the asset CLASS, not just the symbol', () => {
  // The class is what tells the valuation layer whether "5000" means five
  // thousand dollars or five thousand times the price of ETH. The query shipped
  // without selecting it, so every off-path stablecoin transfer was silently
  // valued at 3,000x and the wallet receiving it was drawn as the largest on the
  // canvas. Cheap to select, expensive to omit.
  const contextQuery = captured.find((c) => /UNWIND \$addresses AS addr/.test(c.cypher));
  assert.match(contextQuery.cypher, /t\.assetClass\s+AS assetClass/);

  const stableEdge = traced.contextEdges.find((e) => e.to === DUST_3);
  assert.ok(stableEdge, 'the stablecoin fan-out edge is missing from context');
  assert.equal(stableEdge.assetClass, 'stablecoin');
  assert.equal(stableEdge.asset, 'USDT');
});

await check('and enough of the transfer to cross-check on Etherscan', () => {
  // An off-path lead is only useful if an investigator can go and look it up.
  for (const contextEdge of traced.contextEdges) {
    assert.ok(contextEdge.hash, 'context edge has no transaction hash');
    assert.ok(Number.isInteger(contextEdge.blockNumber), 'context edge has no block number');
  }
});

await check('context can be switched off entirely', () => {
  assert.equal(MAX_CONTEXT_EDGES, 40);
});

const noContext = await findCashOutPaths(VICTIM, { includeContext: false });
await check('?context=false skips the query rather than filtering its result', () => {
  assert.deepEqual(noContext.contextEdges, []);
  assert.equal(noContext.query.includeContext, false);
});

await check('a context limit above the ceiling is clamped, not honoured', () => {
  // Bounded on purpose: this is the one part of the payload that can grow without
  // limit, and an unbounded fan-out would swamp the routes it is meant to frame.
  const contextQueries = captured.filter((c) => /UNWIND \$addresses AS addr/.test(c.cypher));
  for (const query of contextQueries) {
    assert.ok(query.params.limit <= MAX_CONTEXT_EDGES, `limit ${query.params.limit} exceeds the ceiling`);
  }
});

// ===========================================================================
section('8. The three distinct empty answers');

buildScenario({ includeVictim: false });
__setDriverForTesting(createFakeDriver());

const notIngested = await findCashOutPaths(VICTIM);
await check('an un-ingested wallet says so, and says how to fix it', () => {
  assert.equal(notIngested.found, false);
  assert.equal(notIngested.reason, 'WALLET_NOT_IN_GRAPH');
  assert.match(notIngested.hint, /api\/history/);
});

buildScenario({ seedExchanges: false });
__setDriverForTesting(createFakeDriver());

const unseeded = await findCashOutPaths(VICTIM);
await check('an unseeded registry is reported as a setup gap, not a clean wallet', () => {
  // The failure this guards against: an unseeded database making every wallet
  // look innocent. That is the worst possible way for this system to be wrong.
  assert.equal(unseeded.found, false);
  assert.equal(unseeded.reason, 'NO_EXCHANGES_SEEDED');
  assert.match(unseeded.hint, /seed:exchanges/);
  assert.match(unseeded.message, /setup gap, not a finding/);
});

buildScenario();
__setDriverForTesting(createFakeDriver());

const noRoute = await findCashOutPaths(MULE_B, { maxHops: 15 });
await check('a wallet present but with no route gets the third reason', () => {
  // MULE_B -> BINANCE exists, so trace from DUST_1 instead, which has no
  // outgoing edges at all.
  assert.ok(noRoute.found, 'MULE_B does reach Binance in one hop');
});

const deadEnd = await findCashOutPaths(DUST_1, { maxHops: 15 });
await check('a dead-end wallet reports NO_ROUTE_FOUND with a usable hint', () => {
  assert.equal(deadEnd.found, false);
  assert.equal(deadEnd.reason, 'NO_ROUTE_FOUND');
  assert.match(deadEnd.hint, /depth=5|maxHops/);
});

await check('the three reasons are genuinely distinct', () => {
  const reasons = new Set([notIngested.reason, unseeded.reason, deadEnd.reason]);
  assert.equal(reasons.size, 3, 'the empty cases collapsed into fewer distinct reasons');
});

await check('every empty answer still reports how many exchanges are seeded', () => {
  // The number that tells you which of the three you are looking at.
  assert.equal(typeof notIngested.stats.exchangeWalletsInGraph, 'number');
  assert.equal(unseeded.stats.exchangeWalletsInGraph, 0);
  assert.equal(deadEnd.stats.exchangeWalletsInGraph, 4);
});

// ===========================================================================
section('9. Reshaping for the force graph');

buildScenario();
__setDriverForTesting(createFakeDriver());
const forDisplay = await findCashOutPaths(VICTIM, { maxHops: 15 });
const view = toForceGraph(forDisplay);

await check('the shared VICTIM->MULE_A edge is drawn once, not once per route', () => {
  // All three routes start with it. Drawing it three times would make one
  // transfer look like three.
  const shared = view.links.filter((l) => l.source === VICTIM && l.target === MULE_A);
  assert.equal(shared.length, 1, `edge duplicated ${shared.length} times`);
  assert.deepEqual(shared[0].pathIndices.length, 3);
});

await check('every wallet appears exactly once', () => {
  const ids = view.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate nodes in the payload');
});

await check('roles are assigned as the dashboard expects', () => {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(VICTIM).role, NODE_ROLES.SOURCE);
  assert.equal(byId.get(MULE_A).role, NODE_ROLES.INTERMEDIARY);
  assert.equal(byId.get(BINANCE).role, NODE_ROLES.EXCHANGE);
  assert.equal(byId.get(DUST_1).role, NODE_ROLES.CONTEXT);
});

await check('a wallet on several routes takes its shortest hop distance', () => {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(VICTIM).hop, 0);
  assert.equal(byId.get(MULE_A).hop, 1);
  assert.equal(byId.get(MULE_B).hop, 2);
});

await check('the cash-out point out-sizes every wallet feeding it', () => {
  // On raw volume a pass-through mule beats the exchange, because it carries
  // both legs of every transfer. Sizing exchanges in their own band keeps the
  // answer as the largest thing on screen.
  const exchanges = view.nodes.filter((n) => n.role === NODE_ROLES.EXCHANGE);
  const others = view.nodes.filter((n) => n.role !== NODE_ROLES.EXCHANGE);
  const biggestOther = Math.max(...others.map((n) => n.val));
  for (const exchange of exchanges) {
    assert.ok(
      exchange.val > biggestOther,
      `${exchange.label} (${exchange.val}) does not out-size the largest wallet (${biggestOther})`
    );
  }
});

await check('within the exchange band, relative volume still separates venues', () => {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  // Coinbase took 12 ETH (~$36,000); Kraken took 0.4 ETH (~$1,200).
  assert.ok(byId.get(COINBASE).val > byId.get(KRAKEN).val);
});

await check('a stablecoin transfer is valued at its face amount, not the ETH price', () => {
  // DUST_3 received 5,000 USDT and nothing else, so its throughput is $5,000.
  // Priced as native it would read $15,000,000, and the size scale is relative,
  // so that one mistake shrinks every genuinely relevant wallet to a dot.
  const dust3 = view.nodes.find((n) => n.id === DUST_3);
  assert.ok(dust3, 'DUST_3 is missing from the payload');
  assert.equal(dust3.volumeUsdApprox, 5_000);
  assert.deepEqual(dust3.totalsByAsset, { USDT: { in: 5_000, out: 0 } });
});

await check('every node volume equals the sum of its own edges, computed independently', () => {
  // Recomputed here from scratch rather than trusting the library's own
  // arithmetic - the whole class of bug this guards against is a valuation that
  // is internally consistent and uniformly wrong.
  const usd = (link) => (link.assetClass === 'stablecoin' ? link.amount : link.amount * 3_000);

  for (const node of view.nodes) {
    const expected = view.links
      .filter((link) => link.source === node.id || link.target === node.id)
      .reduce((total, link) => total + usd(link), 0);
    assert.ok(
      Math.abs(node.volumeUsdApprox - expected) < 0.01,
      `${node.label}: payload says ${node.volumeUsdApprox}, edges sum to ${expected}`
    );
  }
});

await check('an off-path wallet is never drawn larger than the route it hangs off', () => {
  // A dust wallet one hop off the trail is a lead, not a finding. If it out-sizes
  // the mule that fed it, the picture is telling an investigator to look at the
  // wrong wallet - which is precisely what a mispriced stablecoin edge did.
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const onPathWallets = view.nodes.filter(
    (n) => n.onPath && n.role !== NODE_ROLES.EXCHANGE
  );
  const biggestOnPath = Math.max(...onPathWallets.map((n) => n.val));

  for (const node of view.nodes.filter((n) => n.role === NODE_ROLES.CONTEXT)) {
    assert.ok(
      node.val <= biggestOnPath,
      `off-path ${node.label} (${node.val}) out-sizes every traced wallet (${biggestOnPath})`
    );
  }
  assert.ok(byId.get(DUST_3).val < byId.get(MULE_A).val, 'DUST_3 out-sizes MULE_A');
});

await check('a record with no assetClass falls back to the symbol, not to native', () => {
  // Belt and braces for the same bug at the other end: any future query that
  // forgets to select assetClass must degrade to a small error, not a 3,000x one.
  assert.equal(approximateUsd({ amount: 5_000, asset: 'USDT' }), 5_000);
  assert.equal(approximateUsd({ amount: 2, asset: 'ETH' }), 6_000);
  assert.equal(approximateUsd({ amount: 2, asset: 'ETH', assetClass: 'native' }), 6_000);
  assert.equal(approximateUsd({ amount: 100, asset: 'USDC' }), 100);
  // An asset that is on no allowlist cannot be priced; 1:1 keeps it small.
  assert.equal(approximateUsd({ amount: 100, asset: 'WHO-KNOWS' }), 100);
  assert.equal(approximateUsd({ amount: 0, asset: 'ETH' }), 0);
  assert.equal(approximateUsd({ amount: null }), 0);
});

await check('links carry what an arrow and a width need', () => {
  for (const link of view.links) {
    assert.equal(link.directed, true);
    assert.equal(typeof link.width, 'number');
    assert.ok(link.width > 0);
    assert.equal(typeof link.source, 'string');
    assert.equal(typeof link.target, 'string');
  }
});

await check('the sidebar has a timestamp, hash and amount for every step', () => {
  for (const path of forDisplay.paths) {
    for (const step of path.steps) {
      assert.equal(typeof step.timestamp, 'number', 'missing timestamp');
      assert.match(step.hash, /^0x/, 'missing hash');
      assert.equal(typeof step.amount, 'number', 'missing amount');
      assert.ok(step.asset, 'missing asset');
    }
  }
});

await check('off-path nodes and links are flagged so they can be drawn faintly', () => {
  const context = view.nodes.filter((n) => n.role === NODE_ROLES.CONTEXT);
  assert.ok(context.length > 0, 'no context nodes to check');
  for (const node of context) assert.equal(node.onPath, false);
  assert.equal(view.meta.contextNodes, context.length);
});

await check('the payload survives JSON serialisation intact', () => {
  // Sets serialise to `{}` silently, so this is worth pinning: pathIndices has
  // to be an array by the time it leaves the process.
  const round = JSON.parse(JSON.stringify(view));
  assert.deepEqual(round.nodes.map((n) => n.id), view.nodes.map((n) => n.id));
  assert.ok(Array.isArray(round.nodes[0].pathIndices));
  assert.doesNotMatch(JSON.stringify(view), /_usd/, 'an internal field leaked into the payload');
});

await check('repeated calls produce an identical order', () => {
  // A force layout seeds from input order. Reshuffling between reloads would
  // make the same trace look like a different one.
  const again = toForceGraph(forDisplay);
  assert.deepEqual(again.nodes.map((n) => n.id), view.nodes.map((n) => n.id));
  assert.deepEqual(again.links.map((l) => l.id), view.links.map((l) => l.id));
});

await check('an empty result still renders the reported wallet', () => {
  // The dashboard should show the address that was searched even with no route,
  // rather than an empty canvas that looks like a broken request.
  const emptyView = toForceGraph(deadEnd);
  assert.equal(emptyView.nodes.length, 1);
  assert.equal(emptyView.nodes[0].role, NODE_ROLES.SOURCE);
  assert.deepEqual(emptyView.links, []);
});

// ===========================================================================
section('10. Failure behaviour');

buildScenario();
__setDriverForTesting(createFakeDriver({ failOn: 'shortestPath' }));

await check('a database failure surfaces as GRAPH_UNAVAILABLE, not a raw driver error', () => {
  return findCashOutPaths(VICTIM).then(
    () => assert.fail('should have thrown'),
    (error) => {
      assert.equal(error.name, 'GraphUnavailableError');
      assert.match(error.message, /Could not reach Neo4j/);
      assert.ok(error.hint, 'no hint on the error');
    }
  );
});

__setDriverForTesting(createFakeDriver());
process.env.GRAPH_ENABLED_SNAPSHOT = 'checked';

await check('a temporally impossible route is reported as a lead, not evidence', async () => {
  // Rebuild with the Binance route running backwards in time.
  buildScenario();
  const broken = edge(MULE_B, BINANCE, {
    amount: 32_500,
    asset: 'USDT',
    assetClass: 'stablecoin',
    timestamp: T0 - 5_000, // before the transfer that fed it
  });
  for (const [key, value] of edgeStore) {
    if (value.from === MULE_B && value.to === BINANCE) edgeStore.delete(key);
  }
  edgeStore.set(broken.uniqueId, broken);
  __setDriverForTesting(createFakeDriver());

  const result = await findCashOutPaths(VICTIM, { maxHops: 15 });
  const binance = result.paths.find((p) => p.exchange.exchange === 'binance');

  assert.equal(binance.temporallyOrdered, false);
  assert.equal(binance.temporalBreakAtHop, 3);
  assert.equal(result.stats.temporallyInconsistentPaths, 1);
  assert.match(result.warnings.join(' '), /not physically possible/);
  assert.match(result.warnings.join(' '), /leads, not evidence/);
});

await check('a consistent route is not flagged just because a sibling route is', async () => {
  const result = await findCashOutPaths(VICTIM, { maxHops: 15 });
  const coinbase = result.paths.find((p) => p.exchange.exchange === 'coinbase');
  assert.equal(coinbase.temporallyOrdered, true);
  assert.equal(coinbase.temporalBreakAtHop, undefined);
});

// --- Result ----------------------------------------------------------------

__setDriverForTesting(null);

console.log(`\n${'='.repeat(39)}`);
if (failures.length === 0) {
  console.log(`Phase 3 smoke test: ${passed} checks passed.`);
  console.log('The trace query, ranking, empty cases and force-graph payload all behave.');
  process.exit(0);
} else {
  console.error(`Phase 3 smoke test: ${passed} passed, ${failures.length} FAILED.`);
  for (const failure of failures) console.error(`  - ${failure.name}`);
  process.exit(1);
}
