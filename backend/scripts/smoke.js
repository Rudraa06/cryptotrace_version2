/**
 * scripts/smoke.js
 * ---------------------------------------------------------------------------
 * Self-verifying Phase 1 test. Runs entirely offline against the fixture
 * scenario - no API key, no network, no Neo4j.
 *
 * Run with:  npm run smoke
 *
 * It asserts the behaviours that are easy to break and hard to eyeball:
 *
 *   1. The trace reaches BOTH seeded exchanges at hop 3.
 *   2. Sub-threshold dust is filtered out.
 *   3. The cycle guard prevents re-expanding an already-visited wallet.
 *   4. Exchange wallets are marked terminal and never expanded.
 *   5. Consolidation is detected (two hop-1 branches converge on one hop-2 wallet).
 *   6. Amounts survive decimal conversion exactly (USDT has 6 decimals).
 *   7. Hop labels are shortest-path correct.
 *   8. Depth clamping is enforced.
 *
 * Exits non-zero on any failure, so it works as a pre-demo confidence check and
 * drops straight into CI later.
 */

// MOCK_MODE must be set before any module reads config.
process.env.MOCK_MODE = 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
process.env.MAX_TRACE_DEPTH = '5';
process.env.MIN_NATIVE_VALUE = '0.001';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_FILE = path.join(PACKAGE_ROOT, 'fixtures', 'mock-transfers.json');

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

// --- Load fixture, then the service under test -----------------------------

let fixture;
try {
  fixture = JSON.parse(await fs.readFile(FIXTURE_FILE, 'utf8'));
} catch (error) {
  console.error(
    `\nCould not read ${path.relative(PACKAGE_ROOT, FIXTURE_FILE)}.\n` +
      'Run "npm run seed:fixtures" first.\n'
  );
  process.exit(1);
}

const { fetchWalletHistory } = await import('../src/services/walletHistory.service.js');
const { normalizeTransfer } = await import('../src/services/assetTransfers.js');

const SUSPECT = fixture.participants.suspect;
const [LAYER1_A, LAYER1_B, LAYER1_C] = fixture.participants.hop1;
const [LAYER2_A, LAYER2_B] = fixture.participants.hop2;
const [BINANCE, COINBASE] = fixture.participants.exchanges;
const [GAS_FEEDER, DUST_DECOY] = fixture.participants.sideBranch;

console.log('\nPhase 1 smoke test (MOCK_MODE, offline)');
console.log(`Scenario: ${fixture.scenario}\n`);

// --- Run the trace once and assert against it ------------------------------

const result = await fetchWalletHistory(SUSPECT, 3);

/** @param {string} address */
const wallet = (address) => result.wallets.find((w) => w.address === address);

await check('trace returns the normalised root address', () => {
  assert.equal(result.root, SUSPECT.toLowerCase());
  assert.equal(result.depth, 3);
});

await check('reaches both seeded exchanges', () => {
  const names = result.exchangesFound.map((e) => e.exchange).sort();
  assert.deepEqual(names, ['Binance', 'Coinbase']);
});

await check('both exchanges are found at hop 3', () => {
  for (const found of result.exchangesFound) {
    assert.equal(found.hop, 3, `${found.exchange} was at hop ${found.hop}, expected 3`);
  }
});

await check('exchange wallets are flagged isExchange for the Neo4j schema', () => {
  assert.equal(wallet(BINANCE)?.isExchange, true);
  assert.equal(wallet(COINBASE)?.isExchange, true);
  assert.equal(wallet(LAYER2_A)?.isExchange, false);
});

await check('exchange wallets are terminal and never expanded', () => {
  const binance = wallet(BINANCE);
  assert.equal(binance.expanded, false, 'Binance must not be expanded');
  assert.equal(binance.notExpandedReason, 'known-exchange-terminal');

  // The fixture defines a 500,000 USDT onward transfer from Binance. If the
  // traversal followed it, that edge would appear in the results.
  const leaked = result.transactions.filter((t) => t.from === BINANCE);
  assert.equal(leaked.length, 0, `followed ${leaked.length} transfer(s) out of an exchange`);
});

await check('sub-threshold dust transfer is filtered out', () => {
  // suspect -> DUST_DECOY is 0.0002 ETH, below MIN_NATIVE_VALUE (0.001).
  const dustEdges = result.transactions.filter((t) => t.from === SUSPECT && t.to === DUST_DECOY);
  assert.equal(dustEdges.length, 0, 'dust transfer should have been discarded');
  assert.ok(result.stats.transfersDiscarded >= 1, 'expected at least one discarded transfer');
});

await check('above-threshold native transfer IS traced', () => {
  // suspect -> GAS_FEEDER is 0.4 ETH, comfortably above the threshold.
  const edge = result.transactions.find((t) => t.from === SUSPECT && t.to === GAS_FEEDER);
  assert.ok(edge, 'expected the 0.4 ETH transfer to be kept');
  assert.equal(edge.asset, 'ETH');
  assert.equal(edge.assetClass, 'native');
  assert.ok(Math.abs(edge.amount - 0.4) < 1e-12, `amount was ${edge.amount}`);
});

await check('consolidation detected: two hop-1 branches converge on LAYER2-A', () => {
  const inbound = result.transactions.filter((t) => t.to === LAYER2_A).map((t) => t.from);
  assert.ok(inbound.includes(LAYER1_A), 'missing LAYER1-A -> LAYER2-A');
  assert.ok(inbound.includes(LAYER1_B), 'missing LAYER1-B -> LAYER2-B');
  assert.equal(wallet(LAYER2_A).inboundCount, 2);
});

await check('cycle guard: LAYER1-A reached at hop 1 and not re-expanded via back-edge', () => {
  // LAYER2-A sends 100 USDT back to LAYER1-A. The edge should be recorded, but
  // LAYER1-A must keep its shortest-path hop of 1 and must not be re-queued.
  const backEdge = result.transactions.find((t) => t.from === LAYER2_A && t.to === LAYER1_A);
  assert.ok(backEdge, 'the back-edge should still be recorded as evidence');
  assert.equal(wallet(LAYER1_A).hop, 1, 'hop label must remain the shortest distance');

  // Each address may be expanded at most once.
  const addresses = result.wallets.filter((w) => w.expanded).map((w) => w.address);
  assert.equal(new Set(addresses).size, addresses.length, 'an address was expanded twice');
});

await check('hop labels are shortest-path correct', () => {
  assert.equal(wallet(SUSPECT).hop, 0);
  assert.equal(wallet(LAYER1_A).hop, 1);
  assert.equal(wallet(LAYER1_B).hop, 1);
  assert.equal(wallet(LAYER1_C).hop, 1);
  assert.equal(wallet(LAYER2_A).hop, 2);
  assert.equal(wallet(LAYER2_B).hop, 2);
  assert.equal(wallet(BINANCE).hop, 3);
});

await check('USDT amounts survive 6-decimal conversion exactly', () => {
  const edge = result.transactions.find((t) => t.from === SUSPECT && t.to === LAYER1_A);
  assert.ok(edge, 'missing suspect -> LAYER1-A edge');
  assert.equal(edge.asset, 'USDT');
  assert.equal(edge.amount, 18000);
  assert.equal(edge.contract, '0xdac17f958d2ee523a2206206994597c13d831ec7');
});

await check('every transaction carries the fields the Neo4j schema needs', () => {
  for (const transaction of result.transactions) {
    assert.equal(typeof transaction.hash, 'string', 'hash must be a string');
    assert.ok(transaction.hash.startsWith('0x'), `bad hash ${transaction.hash}`);
    assert.equal(typeof transaction.amount, 'number', 'amount must be Float');
    assert.ok(Number.isInteger(transaction.timestamp), 'timestamp must be an Integer');
    assert.ok(transaction.timestamp > 0, 'timestamp must be populated');
    assert.ok(Number.isInteger(transaction.blockNumber), 'blockNumber must be an Integer');
    assert.ok(transaction.blockNumber > 0, 'blockNumber must be populated');
    assert.match(transaction.from, /^0x[0-9a-f]{40}$/, 'from must be lowercase hex');
    assert.match(transaction.to, /^0x[0-9a-f]{40}$/, 'to must be lowercase hex');
  }
});

await check('no self-loops in the graph', () => {
  const loops = result.transactions.filter((t) => t.from === t.to);
  assert.equal(loops.length, 0, `found ${loops.length} self-loop(s)`);
});

await check('edges are deduplicated by uniqueId', () => {
  const ids = result.transactions.map((t) => t.uniqueId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate uniqueId in output');
});

const shallow = await fetchWalletHistory(SUSPECT, 1);
await check('depth=1 reaches no exchange and warns about it', () => {
  assert.equal(shallow.depth, 1);
  assert.equal(shallow.exchangesFound.length, 0);
  assert.ok(
    shallow.warnings.some((w) => w.includes('No known exchange reached')),
    'expected a warning about no exchange found'
  );
  assert.ok(shallow.wallets.every((w) => w.hop <= 1));
});

await check('depth-truncated wallets are distinguishable from exchange terminals', () => {
  // At depth 1 the hop-1 wallets are the frontier: the trail is cut by the depth
  // limit, not because we found an answer. The UI must be able to tell these
  // apart so it can prompt "search deeper" instead of "cash-out identified".
  const layer1 = shallow.wallets.find((w) => w.address === LAYER1_A);
  assert.equal(layer1.expanded, false);
  assert.equal(layer1.notExpandedReason, 'depth-limit-reached');

  // And they should be offered as actionable leads.
  const lead = shallow.unresolvedLeads.find((l) => l.address === LAYER1_A);
  assert.ok(lead, 'LAYER1-A should appear as an unresolved lead at depth 1');
  assert.equal(lead.reason, 'depth-limit-reached');
});

await check('exchange terminals are NOT reported as unresolved leads', () => {
  // The exchanges are the answer, not loose ends.
  const addresses = result.unresolvedLeads.map((l) => l.address);
  assert.ok(!addresses.includes(BINANCE), 'Binance must not be an unresolved lead');
  assert.ok(!addresses.includes(COINBASE), 'Coinbase must not be an unresolved lead');
});

await check('depth is clamped to MAX_TRACE_DEPTH with a warning', async () => {
  const deep = await fetchWalletHistory(SUSPECT, 99);
  assert.equal(deep.depth, 5, 'should clamp to MAX_TRACE_DEPTH=5');
  assert.ok(
    deep.warnings.some((w) => w.includes('clamped')),
    'expected a clamping warning'
  );
});

await check('invalid addresses are rejected with InvalidAddressError', async () => {
  await assert.rejects(() => fetchWalletHistory('not-an-address', 2), {
    name: 'InvalidAddressError',
  });
  // 39 hex digits: one short.
  await assert.rejects(() => fetchWalletHistory('0x' + 'a'.repeat(39), 2), {
    name: 'InvalidAddressError',
  });
});

await check('mixed-case (bad EIP-55 checksum) input is accepted and normalised', async () => {
  // Victim-reported addresses arrive from screenshots and WhatsApp forwards with
  // mangled capitalisation. Rejecting those would be hostile to the real user.
  const mangled = SUSPECT.toUpperCase().replace('0X', '0x');
  const traced = await fetchWalletHistory(mangled, 1);
  assert.equal(traced.root, SUSPECT.toLowerCase());
});

await check('unknown ERC-20 contracts are discarded by the allowlist', () => {
  const spam = {
    hash: `0x${'1'.repeat(64)}`,
    from: SUSPECT,
    to: LAYER1_A,
    value: 1_000_000,
    asset: 'SCAM',
    category: 'erc20',
    blockNum: '0x1',
    metadata: { blockTimestamp: '2026-01-01T00:00:00.000Z' },
    rawContract: { value: '0xf4240', address: `0x${'9'.repeat(40)}`, decimal: '0x6' },
  };
  assert.equal(normalizeTransfer(spam), null, 'non-allowlisted token should be dropped');
});

await check('contract-creation transfers (to === null) are discarded', () => {
  const creation = {
    hash: `0x${'2'.repeat(64)}`,
    from: SUSPECT,
    to: null,
    value: 1,
    asset: 'ETH',
    category: 'external',
    blockNum: '0x1',
    metadata: { blockTimestamp: '2026-01-01T00:00:00.000Z' },
    rawContract: { value: '0xde0b6b3a7640000', address: null, decimal: '0x12' },
  };
  assert.equal(normalizeTransfer(creation), null);
});

// --- Resilience layer ------------------------------------------------------
// Rate-limit handling is the single most likely thing to fail during a live
// demo, and it is invisible until it fires. Test it explicitly.

const { isRetryable, withRetry } = await import('../src/lib/retry.js');
const { createLimiter } = await import('../src/lib/concurrency.js');

await check('isRetryable: 429 and 5xx are retryable, 4xx and bad-params are not', () => {
  assert.equal(isRetryable({ status: 429 }), true, 'HTTP 429');
  assert.equal(isRetryable({ status: 503 }), true, 'HTTP 503');
  assert.equal(isRetryable({ error: { code: -32005 } }), true, 'Alchemy limit exceeded');
  assert.equal(isRetryable({ code: 'ECONNRESET' }), true, 'socket reset');
  assert.equal(isRetryable({ code: 'TIMEOUT' }), true, 'timeout');
  assert.equal(isRetryable(new Error('Too Many Requests')), true, 'message match');

  // A bad or over-quota API key must fail fast, not burn 5 retries and 30s.
  assert.equal(isRetryable({ status: 401 }), false, 'HTTP 401');
  assert.equal(isRetryable({ status: 403 }), false, 'HTTP 403');
  assert.equal(isRetryable({ status: 400 }), false, 'HTTP 400');
  assert.equal(isRetryable({ error: { code: -32602 } }), false, 'invalid params');
});

await check('withRetry recovers from a transient failure', async () => {
  let attempts = 0;
  const value = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
      return 'recovered';
    },
    { maxRetries: 5, baseDelayMs: 5, label: 'test' }
  );
  assert.equal(value, 'recovered');
  assert.equal(attempts, 3, 'should have taken exactly 3 attempts');
});

await check('withRetry does NOT retry a permanent failure', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('bad api key'), { status: 401 });
        },
        { maxRetries: 5, baseDelayMs: 5, label: 'test' }
      ),
    { name: 'RpcRetryError' }
  );
  assert.equal(attempts, 1, 'a 401 must fail on the first attempt');
});

await check('withRetry surfaces RpcRetryError as HTTP 503 after exhausting retries', async () => {
  const error = await withRetry(
    async () => {
      throw Object.assign(new Error('still rate limited'), { status: 429 });
    },
    { maxRetries: 2, baseDelayMs: 5, label: 'test' }
  ).catch((e) => e);

  assert.equal(error.name, 'RpcRetryError');
  assert.equal(error.statusCode, 503);
  assert.equal(error.attempts, 3, 'first attempt + 2 retries');
});

await check('createLimiter never exceeds its concurrency cap', async () => {
  const limit = createLimiter(3);
  let inFlight = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 20 }, () =>
      limit(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      })
    )
  );

  assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`);
  assert.equal(inFlight, 0);
});

await check('createLimiter releases its slot when a task rejects (no deadlock)', async () => {
  const limit = createLimiter(1);
  await assert.rejects(() => limit(async () => { throw new Error('boom'); }), /boom/);
  // If the failed task leaked its slot, this would hang forever.
  const after = await limit(async () => 'ok');
  assert.equal(after, 'ok');
});

// --- Report ----------------------------------------------------------------

console.log('');
console.log('Trace summary');
console.log(`  wallets discovered : ${result.wallets.length}`);
console.log(`  transactions kept  : ${result.transactions.length}`);
console.log(`  transfers filtered : ${result.stats.transfersDiscarded}`);
console.log(`  addresses expanded : ${result.stats.addressesExpanded}`);
console.log(`  rpc calls (mocked) : ${result.stats.rpcCalls}`);
console.log('');
console.log('Cash-out points identified');
for (const found of result.exchangesFound) {
  console.log(
    `  hop ${found.hop}  ${found.exchange.padEnd(10)} ${found.label.padEnd(22)} ` +
      `received ${found.receivedValue} across ${found.receivedCount} transfer(s)`
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed.\n`);
  process.exit(1);
}
console.log(`All ${passed} checks passed.\n`);
