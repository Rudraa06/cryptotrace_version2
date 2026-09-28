/**
 * scripts/smoke-graph.js
 * ---------------------------------------------------------------------------
 * Self-verifying Phase 2 test. Runs entirely offline: no Neo4j, no API key, no
 * network.
 *
 * Run with:  npm run smoke:graph
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS, AND WHY IT IS WORTH HAVING
 * ---------------------------------------------------------------------------
 * A fake Bolt driver is injected into the Neo4j service, so every query the
 * ingestion layer would send is captured and inspected instead of executed. That
 * catches the class of bug you otherwise only find by reading rows in Neo4j
 * Browser and noticing something is subtly off:
 *
 *   - a timestamp stored as Float 1.7356896E9 instead of Integer 1735689600,
 *   - MERGE keyed on `hash` so batched payouts lose edges,
 *   - `isExchange` overwritten to false by a later trace, quietly breaking
 *     Phase 3's shortestPath,
 *   - batching that sends one query per row.
 *
 * It also runs the real Phase 1 traversal in MOCK_MODE and feeds its actual
 * output into `ingestToGraph`, so the two phases are verified against each other
 * rather than against my assumptions about the shape they exchange.
 */

// Environment must be set before any module reads config.
process.env.MOCK_MODE = 'true';
process.env.GRAPH_ENABLED = 'true';
process.env.NEO4J_PASSWORD = 'offline-test-password';
process.env.GRAPH_BATCH_SIZE = '500';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.MAX_TRACE_DEPTH = '5';

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

// --- The fake driver -------------------------------------------------------

/** Every query the code under test issued, in order. */
let captured = [];

/** Statements the fake server should reject, to exercise the failure paths. */
let rejectPatterns = [];

/**
 * A Neo4j Integer stand-in. Distinguishable from a plain JS number, which is the
 * entire point of the type-coercion assertions below.
 * @param {number} value
 */
function fakeInt(value) {
  return { __neoInt: true, value, toNumber: () => value };
}

/** @param {any} value */
function isFakeInt(value) {
  return Boolean(value && typeof value === 'object' && value.__neoInt === true);
}

/**
 * Build a driver that records queries instead of running them.
 */
function createFakeDriver() {
  /**
   * @param {string} cypher
   * @param {Record<string, any>} params
   */
  const run = async (cypher, params = {}) => {
    captured.push({ cypher, params });

    for (const pattern of rejectPatterns) {
      if (pattern.match.test(cypher)) {
        const error = new Error(pattern.message);
        error.code = pattern.code ?? 'Neo.ClientError.Statement.SyntaxError';
        throw error;
      }
    }

    const rows = Array.isArray(params.rows) ? params.rows : [];

    // Only the queries that read something back need records.
    const records = /AS seeded/.test(cypher)
      ? [{ keys: ['seeded'], get: () => fakeInt(rows.length) }]
      : [];

    return {
      records,
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: rows.length,
            relationshipsCreated: /\[t:TRANSACTION/.test(cypher) ? rows.length : 0,
            propertiesSet: rows.length * 5,
            constraintsAdded: /CREATE CONSTRAINT/.test(cypher) ? 1 : 0,
            indexesAdded: /CREATE INDEX/.test(cypher) ? 1 : 0,
            nodesDeleted: 0,
            relationshipsDeleted: 0,
            labelsAdded: 0,
          }),
        },
      },
    };
  };

  const session = () => ({
    run,
    // Managed transactions: hand the work a tx object exposing the same run().
    executeWrite: async (work) => work({ run }),
    executeRead: async (work) => work({ run }),
    close: async () => {},
  });

  return {
    session,
    close: async () => {},
    getServerInfo: async () => ({ protocolVersion: 5.0 }),
    verifyConnectivity: async () => true,
  };
}

/** Discard captured queries between checks. */
function resetCapture() {
  captured = [];
  rejectPatterns = [];
}

/** @param {RegExp} pattern */
function capturedMatching(pattern) {
  return captured.filter((entry) => pattern.test(entry.cypher));
}

// --- Load the modules under test -------------------------------------------

const { __setDriverForTesting, toNeoInt, fromNeoInt, GraphUnavailableError, GraphDisabledError } =
  await import('../src/services/neo4j.service.js');

__setDriverForTesting(createFakeDriver(), { int: fakeInt, auth: { basic: () => ({}) } });

const {
  ingestToGraph,
  seedExchangeWallets,
  computeRiskScore,
  WALLET_MERGE_CYPHER,
  TRANSACTION_MERGE_CYPHER,
  RISK_MODEL,
} = await import('../src/services/graph.service.js');

const { applyGraphSchema, SCHEMA_STATEMENTS } = await import('../src/services/graphSchema.js');
const { fetchWalletHistory } = await import('../src/services/walletHistory.service.js');
const { listKnownExchanges } = await import('../src/config/knownExchanges.js');

console.log('\nPhase 2 smoke test (fake Bolt driver, no Neo4j required)\n');

// ===========================================================================
// 1. The schema decision
// ===========================================================================

await check('edge MERGE keys on uniqueId, never on hash', () => {
  // The single most consequential line in Phase 2. Keyed on `hash`, a batched
  // exchange payout would write one edge and silently drop the rest - and the
  // dropped one can be the edge that reaches the exchange.
  assert.match(
    TRANSACTION_MERGE_CYPHER,
    /MERGE \(sender\)-\[t:TRANSACTION \{ uniqueId: row\.uniqueId \}\]->\(recipient\)/,
    'relationship MERGE must key on uniqueId'
  );
  assert.doesNotMatch(
    TRANSACTION_MERGE_CYPHER,
    /MERGE[^\n]*TRANSACTION \{ hash:/,
    'relationship MERGE must not key on hash'
  );
  // hash must still be written, because it is what an investigator cross-checks
  // against Etherscan.
  assert.match(TRANSACTION_MERGE_CYPHER, /t\.hash\s*=\s*row\.hash/);
});

await check('schema declares Wallet.address unique and TRANSACTION.hash indexed', () => {
  const byName = new Map(SCHEMA_STATEMENTS.map((s) => [s.name, s]));

  const walletConstraint = byName.get('wallet_address_unique');
  assert.ok(walletConstraint, 'missing wallet_address_unique');
  assert.equal(walletConstraint.kind, 'constraint');
  assert.match(walletConstraint.cypher, /w\.address IS UNIQUE/);
  // Required, not optional: without it every MERGE degrades to a label scan.
  assert.notEqual(walletConstraint.optional, true);

  const uniqueId = byName.get('transaction_unique_id');
  assert.ok(uniqueId, 'missing transaction_unique_id');
  assert.match(uniqueId.cypher, /t\.uniqueId IS UNIQUE/);

  const hashIndex = byName.get('transaction_hash');
  assert.ok(hashIndex, 'missing transaction_hash index');
  assert.equal(hashIndex.kind, 'index');
  assert.match(hashIndex.cypher, /ON \(t\.hash\)/);
});

await check('isExchange index exists - Phase 3 shortestPath depends on it', () => {
  const index = SCHEMA_STATEMENTS.find((s) => s.name === 'wallet_is_exchange');
  assert.ok(index, 'missing wallet_is_exchange index');
  assert.match(index.cypher, /FOR \(w:Wallet\) ON \(w\.isExchange\)/);
});

await check('every schema statement is idempotent (IF NOT EXISTS)', () => {
  for (const statement of SCHEMA_STATEMENTS) {
    assert.match(
      statement.cypher,
      /IF NOT EXISTS/,
      `${statement.name} would fail on a second run`
    );
  }
});

// ===========================================================================
// 2. Schema application and graceful degradation
// ===========================================================================

resetCapture();

await check('applyGraphSchema issues every statement', async () => {
  const result = await applyGraphSchema({ force: true });
  assert.equal(result.applied.length, SCHEMA_STATEMENTS.length);
  assert.equal(result.skipped.length, 0);
  assert.equal(
    capturedMatching(/CREATE (CONSTRAINT|INDEX)/).length,
    SCHEMA_STATEMENTS.length,
    'not all schema statements reached the server'
  );
});

resetCapture();

await check('an unsupported relationship constraint is tolerated, not fatal', async () => {
  // Simulates a Neo4j build that will not accept relationship uniqueness. The
  // MERGE pattern already guarantees the invariant, so this must degrade.
  rejectPatterns = [
    {
      match: /CREATE CONSTRAINT transaction_unique_id/,
      message: 'Relationship uniqueness constraints are not supported in this edition',
      code: 'Neo.ClientError.Schema.ConstraintCreationFailed',
    },
  ];

  const result = await applyGraphSchema({ force: true });
  assert.ok(
    result.skipped.some((s) => s.name === 'transaction_unique_id'),
    'the unsupported constraint should be reported as skipped'
  );
  // Everything else still went in.
  assert.ok(result.applied.includes('wallet_address_unique'));
  assert.ok(result.applied.includes('transaction_hash'));
});

resetCapture();

await check('a failing REQUIRED constraint does fail loudly', async () => {
  rejectPatterns = [
    {
      match: /CREATE CONSTRAINT wallet_address_unique/,
      message: 'permission denied',
      code: 'Neo.ClientError.Security.Forbidden',
    },
  ];
  // Both the 5.x statement and the 4.x fallback are rejected, so this must throw
  // rather than leave the graph unindexed.
  await assert.rejects(() => applyGraphSchema({ force: true }));
});

resetCapture();

// ===========================================================================
// 3. Type coercion - Integer vs Float
// ===========================================================================

/**
 * A minimal but realistic transfer, matching Phase 1's output shape.
 *
 * The addresses deliberately contain hex letters. An address of all digits has an
 * EIP-55 checksum identical to its lowercase form, which would make the
 * display-form assertion below pass or fail for the wrong reason.
 */
const sampleTransfer = {
  uniqueId: '0xaaa:log:12',
  hash: `0x${'a'.repeat(64)}`,
  from: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
  to: '0xab5801a7d398351b8be11c439e05c5b3259aec9b',
  amount: 18000.123456,
  asset: 'USDT',
  assetClass: 'stablecoin',
  contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  blockNumber: 21_000_000,
  timestamp: 1_735_689_600,
  category: 'erc20',
  hop: 1,
};

await check('timestamp and blockNumber are written as Neo4j Integers', async () => {
  resetCapture();
  await ingestToGraph([sampleTransfer]);

  const edgeQuery = capturedMatching(/\[t:TRANSACTION/)[0];
  assert.ok(edgeQuery, 'no TRANSACTION query was issued');

  const row = edgeQuery.params.rows[0];
  assert.ok(isFakeInt(row.timestamp), 'timestamp must be converted with neo4j.int()');
  assert.ok(isFakeInt(row.blockNumber), 'blockNumber must be converted with neo4j.int()');
  assert.equal(row.timestamp.toNumber(), 1_735_689_600);
  assert.equal(row.blockNumber.toNumber(), 21_000_000);
});

await check('amount stays a Float, exact to six decimals', async () => {
  resetCapture();
  await ingestToGraph([sampleTransfer]);
  const row = capturedMatching(/\[t:TRANSACTION/)[0].params.rows[0];

  // The schema types amount as Float. Coercing it to Integer would silently
  // truncate 18000.123456 USDT to 18000 - a real loss of evidence.
  assert.equal(typeof row.amount, 'number');
  assert.ok(!isFakeInt(row.amount));
  assert.equal(row.amount, 18000.123456);
});

await check('toNeoInt/fromNeoInt round-trip, and tolerate nulls', () => {
  assert.equal(fromNeoInt(toNeoInt(42)), 42);
  assert.equal(fromNeoInt(toNeoInt(-7.9)), -7, 'should truncate towards zero');
  assert.equal(toNeoInt(null), null);
  assert.equal(toNeoInt(undefined), null);
  assert.equal(toNeoInt(Number.NaN), null);
  assert.equal(fromNeoInt(null), null);
  assert.equal(fromNeoInt(123), 123);
  assert.equal(fromNeoInt({ toNumber: () => 9 }), 9);
});

await check('addresses are stored lowercase with a checksummed display form', async () => {
  resetCapture();
  await ingestToGraph([sampleTransfer]);
  const row = capturedMatching(/\[t:TRANSACTION/)[0].params.rows[0];

  assert.match(row.from, /^0x[0-9a-f]{40}$/, 'from must be lowercase');
  assert.match(row.to, /^0x[0-9a-f]{40}$/, 'to must be lowercase');
  // Display form is EIP-55, so the UI can show a checksummed address while the
  // graph keys on a single canonical casing.
  assert.equal(row.fromDisplay.toLowerCase(), row.from);
  assert.notEqual(row.fromDisplay, row.from, 'display form should be checksummed');
});

// ===========================================================================
// 4. Merge semantics
// ===========================================================================

await check('isExchange is sticky-true and cannot be downgraded by a later trace', () => {
  // If a trace could reset isExchange to false, Phase 3 would stop finding the
  // cash-out point it had already identified. That is a silent wrong answer,
  // which is the worst kind for an investigative tool.
  assert.match(
    WALLET_MERGE_CYPHER,
    /w\.isExchange\s*=\s*\(coalesce\(w\.isExchange, false\) OR row\.isExchange\)/,
    'ON MATCH must OR the flag, never overwrite it'
  );
});

await check('riskScore keeps the highest observation, minHopObserved the lowest', () => {
  assert.match(WALLET_MERGE_CYPHER, /row\.riskScore > coalesce\(w\.riskScore, 0\)/);
  assert.match(WALLET_MERGE_CYPHER, /row\.hop < coalesce\(w\.minHopObserved, 999\)/);
});

await check('ingestion uses MERGE exclusively - never CREATE', () => {
  // CREATE would duplicate a wallet each time a second victim's trace touched
  // it, and the overlap between victims is the most valuable thing this graph
  // can show.
  for (const cypher of [WALLET_MERGE_CYPHER, TRANSACTION_MERGE_CYPHER]) {
    assert.doesNotMatch(cypher, /(^|\n)\s*CREATE\s+\(/, 'found a bare CREATE');
    assert.match(cypher, /MERGE/);
  }
});

await check('re-ingesting the same trace issues identical writes (idempotent)', async () => {
  resetCapture();
  await ingestToGraph([sampleTransfer]);
  const first = capturedMatching(/\[t:TRANSACTION/)[0];

  resetCapture();
  await ingestToGraph([sampleTransfer]);
  const second = capturedMatching(/\[t:TRANSACTION/)[0];

  assert.equal(first.cypher, second.cypher);
  assert.deepEqual(
    first.params.rows.map((r) => r.uniqueId),
    second.params.rows.map((r) => r.uniqueId)
  );
});

// ===========================================================================
// 5. Batching
// ===========================================================================

await check('large ingests are batched, not sent one row at a time', async () => {
  resetCapture();

  // 1,200 transfers with GRAPH_BATCH_SIZE=500 must become exactly 3 queries.
  const many = Array.from({ length: 1200 }, (unused, index) => ({
    ...sampleTransfer,
    uniqueId: `0xbbb:log:${index}`,
    to: `0x${index.toString(16).padStart(40, '0')}`,
  }));

  const summary = await ingestToGraph(many);

  const edgeQueries = capturedMatching(/\[t:TRANSACTION/);
  assert.equal(edgeQueries.length, 3, `expected 3 batches, got ${edgeQueries.length}`);
  assert.equal(edgeQueries[0].params.rows.length, 500);
  assert.equal(edgeQueries[2].params.rows.length, 200);
  assert.equal(summary.transactionsWritten, 1200);
});

await check('rows are sorted deterministically to reduce deadlock risk', async () => {
  resetCapture();

  const shuffled = [
    { ...sampleTransfer, uniqueId: 'z', from: `0x${'9'.repeat(40)}` },
    { ...sampleTransfer, uniqueId: 'a', from: `0x${'1'.repeat(40)}` },
    { ...sampleTransfer, uniqueId: 'm', from: `0x${'5'.repeat(40)}` },
  ];
  await ingestToGraph(shuffled);

  const rows = capturedMatching(/\[t:TRANSACTION/)[0].params.rows;
  const senders = rows.map((r) => r.from);
  assert.deepEqual(senders, [...senders].sort(), 'rows should be ordered by sender');
});

await check('wallets are written before edges', async () => {
  resetCapture();
  await ingestToGraph([sampleTransfer], [
    { address: sampleTransfer.from, hop: 0, isExchange: false },
  ]);

  const walletIndex = captured.findIndex((entry) => /MERGE \(w:Wallet/.test(entry.cypher));
  const edgeIndex = captured.findIndex((entry) => /\[t:TRANSACTION/.test(entry.cypher));
  assert.ok(walletIndex >= 0 && edgeIndex >= 0);
  assert.ok(
    walletIndex < edgeIndex,
    'nodes must exist first so the edge query takes MERGE\'s match path'
  );
});

// ===========================================================================
// 6. Input validation and call shapes
// ===========================================================================

await check('malformed rows are rejected individually, not fatally', async () => {
  resetCapture();

  const summary = await ingestToGraph([
    sampleTransfer,
    { ...sampleTransfer, uniqueId: undefined },
    { ...sampleTransfer, uniqueId: 'bad-1', to: 'not-an-address' },
    { ...sampleTransfer, uniqueId: 'bad-2', to: sampleTransfer.from },
    { ...sampleTransfer, uniqueId: 'bad-3', amount: Number.NaN },
    null,
  ]);

  assert.equal(summary.transactionsWritten, 1, 'only the good row should be written');
  assert.equal(summary.rejected.length, 5);

  // Each bad row must be rejected for the right reason, so a future change that
  // starts silently dropping good rows cannot hide behind a matching total.
  const reasons = summary.rejected.map((r) => r.reason).sort();
  assert.deepEqual(reasons, [
    'invalid-address',
    'missing-uniqueId',
    'non-numeric-amount',
    'not-an-object',
    'self-loop',
  ]);

  // And the survivor is the one we expected, not an accident of ordering.
  const written = capturedMatching(/\[t:TRANSACTION/)[0].params.rows;
  assert.equal(written[0].uniqueId, sampleTransfer.uniqueId);
});

await check('empty input short-circuits without touching the database', async () => {
  resetCapture();
  const summary = await ingestToGraph([], []);

  assert.equal(summary.ok, true);
  assert.equal(summary.transactionsWritten, 0);
  assert.equal(summary.batches, 0);
  assert.equal(captured.length, 0, 'an empty trace must not issue any query');
  assert.match(summary.warnings[0], /Nothing to ingest/);
});

await check('the roadmap signature ingestToGraph(transactions) creates both endpoints', async () => {
  resetCapture();
  await ingestToGraph([sampleTransfer]);

  // With no wallet list, the edge query itself must be able to create the nodes.
  assert.match(TRANSACTION_MERGE_CYPHER, /MERGE \(sender:Wallet \{ address: row\.from \}\)/);
  assert.match(TRANSACTION_MERGE_CYPHER, /MERGE \(recipient:Wallet \{ address: row\.to \}\)/);
  assert.equal(capturedMatching(/\[t:TRANSACTION/).length, 1);
});

await check('a whole trace object can be passed straight in', async () => {
  resetCapture();
  const summary = await ingestToGraph({
    transactions: [sampleTransfer],
    wallets: [{ address: sampleTransfer.from, hop: 0, isExchange: false }],
  });
  assert.equal(summary.transactionsWritten, 1);
  assert.equal(summary.walletsWritten, 1);
});

await check('a non-array, non-trace argument is rejected clearly', async () => {
  // Every one of these used to slip through as a successful "nothing to ingest",
  // which is the worst possible response to a caller passing the wrong thing.
  await assert.rejects(() => ingestToGraph(42), TypeError);
  await assert.rejects(() => ingestToGraph('[]'), TypeError);
  await assert.rejects(() => ingestToGraph(true), TypeError);
  await assert.rejects(() => ingestToGraph({ root: '0xabc' }), TypeError);
  // A wrong `wallets` argument must fail at the boundary, not deep in a row map.
  await assert.rejects(() => ingestToGraph([sampleTransfer], 'nope'), TypeError);

  // null/undefined are rejected too. An intentionally empty trace is `[]`; null
  // almost always means a caller read a property that was not there, and only one
  // of those two should be allowed to pass silently.
  await assert.rejects(() => ingestToGraph(null), TypeError);
  await assert.rejects(() => ingestToGraph(undefined), TypeError);

  // The empty case still has to work, via the shape that actually means empty.
  assert.equal((await ingestToGraph([])).ok, true);
});

// ===========================================================================
// 7. Risk model
// ===========================================================================

await check('risk score: exchanges score low, the reported wallet scores highest', () => {
  assert.equal(computeRiskScore({ isExchange: true, hop: 3 }), 5);
  assert.equal(computeRiskScore({ hop: 0 }), 100);
  assert.equal(computeRiskScore({ hop: 1 }), 80);
  assert.equal(computeRiskScore({ hop: 2 }), 60);
  // Floor, so a deep wallet is never scored as harmless.
  assert.equal(computeRiskScore({ hop: 12 }), 10);
});

await check('risk score: layering and pass-through behaviour raise the score', () => {
  const plain = computeRiskScore({ hop: 2, inboundCount: 1, outboundCount: 1 });

  const layering = computeRiskScore({ hop: 2, inboundCount: 1, outboundCount: 5 });
  assert.ok(layering > plain, 'splitting one inbound across many outbound should score higher');

  const passThrough = computeRiskScore({
    hop: 2,
    inboundCount: 1,
    outboundCount: 1,
    inboundValue: 1000,
    outboundValue: 995,
  });
  assert.ok(passThrough > plain, 'forwarding ~everything should score higher');

  assert.ok(computeRiskScore({ hop: 0, inboundCount: 1, outboundCount: 9 }) <= 100, 'clamped');
});

await check('risk model is documented for the UI', () => {
  assert.ok(RISK_MODEL.description.length > 40);
  assert.ok(RISK_MODEL.factors.length >= 3);
});

// ===========================================================================
// 8. Exchange seeding
// ===========================================================================

await check('seeding sets isExchange = true on both MERGE branches', async () => {
  resetCapture();
  await seedExchangeWallets(listKnownExchanges());

  const query = capturedMatching(/w\.isExchange\s*=\s*true/)[0];
  assert.ok(query, 'seed query not captured');

  // Seeding is authoritative reference data, so unlike trace ingestion it must
  // correct a node that an earlier trace created as an ordinary wallet.
  const onCreate = query.cypher.split('ON MATCH')[0];
  const onMatch = query.cypher.split('ON MATCH')[1];
  assert.match(onCreate, /w\.isExchange\s*=\s*true/);
  assert.match(onMatch, /w\.isExchange\s*=\s*true/);
});

await check('seeding covers the registry and normalises addresses', async () => {
  resetCapture();
  const exchanges = listKnownExchanges();
  const result = await seedExchangeWallets(exchanges);

  // The roadmap asks for 5 exchange hot wallets; the registry ships more.
  assert.ok(exchanges.length >= 5, `expected at least 5 exchanges, found ${exchanges.length}`);
  assert.equal(result.skipped.length, 0, 'no verified entry should be skipped');

  const evmMaps = capturedMatching(/w\.isExchange\s*=\s*true/);
  const btcMaps = capturedMatching(/c\.isExchange\s*=\s*true/);
  const evmRows = evmMaps.length > 0 ? evmMaps[0].params.rows : [];
  const btcRows = btcMaps.length > 0 ? btcMaps[0].params.rows : [];
  const rows = [...evmRows, ...btcRows];
  assert.equal(rows.length, exchanges.length);
  for (const row of rows) {
    assert.match(row.address, /^(0x[0-9a-f]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[0-9A-Za-z]{39,59})$/i, `not normalised: ${row.address}`);
    assert.ok(row.exchange, 'every seeded wallet needs an operator name');
  }
});

await check('seeding skips a malformed address instead of writing it', async () => {
  resetCapture();
  const result = await seedExchangeWallets([
    { address: 'nonsense', exchange: 'Bad', label: 'Bad 1' },
    { address: `0x${'3'.repeat(40)}`, exchange: 'Good', label: 'Good 1' },
  ]);
  assert.equal(result.skipped.length, 1);
  const rows = capturedMatching(/w\.isExchange\s*=\s*true/)[0].params.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exchange, 'Good');
});

await check('the placeholder WazirX/CoinDCX entries never reach the graph', async () => {
  resetCapture();
  await seedExchangeWallets(listKnownExchanges());
  const rows = capturedMatching(/w\.isExchange\s*=\s*true/)[0].params.rows;

  // A zero-address node flagged as an exchange would make every trace that
  // touches the burn address appear to reach a cash-out point.
  const zero = `0x${'0'.repeat(40)}`;
  assert.ok(!rows.some((row) => row.address === zero), 'zero address must not be seeded');
});

// ===========================================================================
// 9. End to end: real Phase 1 output into Phase 2
// ===========================================================================

let fixtureLoaded = true;
try {
  await fs.access(FIXTURE_FILE);
} catch {
  fixtureLoaded = false;
  console.log('\n  (skipping end-to-end checks: run "npm run seed:fixtures" first)\n');
}

if (fixtureLoaded) {
  const fixture = JSON.parse(await fs.readFile(FIXTURE_FILE, 'utf8'));
  const suspect = fixture?.participants?.suspect || '0x7a400444318d19b01457d9b70cbe9d050ed5260b';
  const trace = await fetchWalletHistory(suspect, 3);

  await check('a real Phase 1 trace ingests without a single rejected row', async () => {
    resetCapture();
    const summary = await ingestToGraph(trace);

    assert.equal(summary.ok, true);
    assert.equal(
      summary.rejected.length,
      0,
      `Phase 1 emitted ${summary.rejected.length} row(s) Phase 2 would not accept: ` +
        JSON.stringify(summary.rejected.slice(0, 3))
    );
    assert.equal(summary.transactionsWritten, trace.transactions.length);
    assert.equal(summary.walletsWritten, trace.wallets.length);
  });

  await check('the exchanges Phase 1 found arrive flagged isExchange', async () => {
    resetCapture();
    await ingestToGraph(trace);

    const walletRows = capturedMatching(/MERGE \(w:Wallet/).flatMap((q) => q.params.rows);
    const flagged = walletRows.filter((row) => row.isExchange === true);

    assert.equal(
      flagged.length,
      trace.exchangesFound.length,
      'every exchange in the trace must be flagged in the graph'
    );
    for (const row of flagged) {
      assert.ok(row.exchange, `flagged wallet ${row.address} has no operator name`);
      // Phase 3 targets these nodes; an unnamed one is useless in the UI.
      assert.ok(row.exchangeLabel, `flagged wallet ${row.address} has no label`);
    }
  });

  await check('exchange nodes are scored low and the reported wallet highest', async () => {
    resetCapture();
    await ingestToGraph(trace);

    const walletRows = capturedMatching(/MERGE \(w:Wallet/).flatMap((q) => q.params.rows);
    const root = walletRows.find((row) => row.address === trace.root);
    const exchange = walletRows.find((row) => row.isExchange === true);

    assert.equal(root.riskScore.toNumber(), 100, 'the reported wallet should score 100');
    assert.equal(exchange.riskScore.toNumber(), 5, 'a known exchange should score 5');
  });

  await check('every ingested edge carries the full schema payload', async () => {
    resetCapture();
    await ingestToGraph(trace);

    const rows = capturedMatching(/\[t:TRANSACTION/).flatMap((q) => q.params.rows);
    assert.ok(rows.length > 0);

    for (const row of rows) {
      assert.ok(row.uniqueId, 'uniqueId is the edge key and cannot be missing');
      assert.match(row.hash, /^0x[0-9a-f]{64}$/i, `bad hash ${row.hash}`);
      assert.equal(typeof row.amount, 'number');
      assert.ok(isFakeInt(row.timestamp), 'timestamp must be an Integer');
      assert.ok(isFakeInt(row.blockNumber), 'blockNumber must be an Integer');
      assert.ok(row.timestamp.toNumber() > 0);
      assert.ok(row.asset, 'asset symbol missing');
    }
  });

  await check('uniqueId is unique across the whole ingested batch', async () => {
    resetCapture();
    await ingestToGraph(trace);

    const ids = capturedMatching(/\[t:TRANSACTION/)
      .flatMap((q) => q.params.rows)
      .map((row) => row.uniqueId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate uniqueId would violate the constraint');
  });

  await check('one hash may legitimately appear on several edges', async () => {
    // The exact case that makes `hash` unsafe as a unique key. The fixture need
    // not contain one, so this asserts the invariant rather than the data: edges
    // are counted by uniqueId, and hash is free to repeat.
    resetCapture();
    await ingestToGraph([
      { ...sampleTransfer, uniqueId: 'shared:log:0', to: `0x${'4'.repeat(40)}` },
      { ...sampleTransfer, uniqueId: 'shared:log:1', to: `0x${'5'.repeat(40)}` },
      { ...sampleTransfer, uniqueId: 'shared:log:2', to: `0x${'6'.repeat(40)}` },
    ]);

    const rows = capturedMatching(/\[t:TRANSACTION/).flatMap((q) => q.params.rows);
    assert.equal(rows.length, 3, 'all three transfers of one transaction must be written');
    assert.equal(new Set(rows.map((r) => r.hash)).size, 1, 'they share one hash');
    assert.equal(new Set(rows.map((r) => r.uniqueId)).size, 3, 'but three distinct uniqueIds');
  });
}

// ===========================================================================
// 10. Error handling
// ===========================================================================

await check('GraphUnavailableError maps to HTTP 503, GraphDisabledError too', () => {
  const unavailable = new GraphUnavailableError('down', { hint: 'start it' });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.name, 'GraphUnavailableError');
  assert.equal(unavailable.hint, 'start it');

  const disabled = new GraphDisabledError();
  assert.equal(disabled.statusCode, 503);
  assert.match(disabled.hint, /GRAPH_ENABLED/);
});

await check('a mid-ingest database failure is handled gracefully and returns ok: false', async () => {
  resetCapture();
  rejectPatterns = [
    {
      match: /\[t:TRANSACTION/,
      message: 'Connection was closed by server',
      code: 'ServiceUnavailable',
    },
  ];

  const summary = await ingestToGraph([sampleTransfer]).catch((e) => e);
  assert.equal(summary.ok, false);
  assert.ok(summary.batchesAttempted > 0, 'Should have attempted batches');
  assert.equal(summary.batchesSucceeded, 0, 'Transaction batch should have failed');
  const hasWarning = summary.warnings.some(w => w.includes('Could not reach') || w.includes('Connection was closed'));
  assert.ok(hasWarning, 'Expected warnings to include "Connection was closed" or "Could not reach"');
  resetCapture();
});

// --- Report ----------------------------------------------------------------

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed.\n`);
  process.exit(1);
}
console.log(`All ${passed} checks passed.\n`);
console.log('Phase 2 ingestion logic is verified offline. To test against a real database:');
console.log('  1. Start your DBMS in Neo4j Desktop');
console.log('  2. npm run seed:exchanges');
console.log('  3. npm run dev,  then trace an address\n');
