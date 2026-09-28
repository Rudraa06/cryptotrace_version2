/**
 * scripts/seed-exchanges.js
 * ---------------------------------------------------------------------------
 * Populate Neo4j with the known exchange hot wallets.
 *
 * Run with:  npm run seed:exchanges
 *
 * This is the third item in Phase 2, and it has to happen BEFORE any trace is
 * useful. Phase 3 answers the problem statement with
 *
 *     shortestPath((suspect)-[:TRANSACTION*]->(exchange))
 *     WHERE exchange.isExchange = true
 *
 * so if nothing in the database carries `isExchange = true`, that query returns
 * nothing and the system looks broken when it is merely unseeded.
 *
 * The script is idempotent - it MERGEs - so running it repeatedly is safe and
 * is in fact the right move after editing the registry.
 *
 * Exit codes: 0 success, 1 failure. Suitable for a pre-demo checklist.
 */

import { assertConfigValid, config } from '../src/config/env.js';
import { listKnownExchanges, unverifiedExchanges } from '../src/config/knownExchanges.js';
import { applyGraphSchema, describeGraphSchema } from '../src/services/graphSchema.js';
import { seedExchangeWallets, getGraphStats } from '../src/services/graph.service.js';
import {
  verifyGraphConnectivity,
  closeDriver,
  runRead,
} from '../src/services/neo4j.service.js';

/** @param {string} text */
function heading(text) {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

/**
 * Print an actionable failure and exit non-zero.
 * @param {string} title
 * @param {string} [detail]
 * @param {string} [hint]
 */
async function fail(title, detail, hint) {
  console.error(`\n  FAILED: ${title}`);
  if (detail) console.error(`\n  ${detail}`);
  if (hint) console.error(`\n  Fix: ${hint}`);
  console.error('');
  await closeDriver();
  process.exit(1);
}

// --- 1. Configuration ------------------------------------------------------

console.log('\nCryptoTrace - seeding exchange wallets into Neo4j');

try {
  // Only the graph half of the config is validated here. This script never calls
  // the blockchain, so demanding ALCHEMY_API_KEY would block the entirely
  // reasonable "set up Neo4j first, get the API key later" order of work - and it
  // would complain about RPC endpoints to someone who is seeding a database.
  assertConfigValid({ only: ['core', 'graph'] });
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

if (!config.graph.enabled) {
  console.error(
    '\n  GRAPH_ENABLED is false, so there is no graph to seed.' +
      '\n  Set GRAPH_ENABLED=true in backend/.env and provide NEO4J_PASSWORD.\n'
  );
  process.exit(1);
}

console.log(`  target   : ${config.graph.uri}`);
console.log(`  database : ${config.graph.database}`);
console.log(`  user     : ${config.graph.user}`);

// --- 2. Connectivity -------------------------------------------------------
// Checked explicitly, up front, so a stopped DBMS produces one clear sentence
// rather than a driver stack trace halfway through writing.

heading('Connectivity');

const connectivity = await verifyGraphConnectivity();

if (!connectivity.ok) {
  await fail(
    'Could not connect to Neo4j.',
    connectivity.message,
    connectivity.hint ??
      'Start the DBMS in Neo4j Desktop and confirm NEO4J_URI/NEO4J_PASSWORD in backend/.env.'
  );
}

console.log(`  connected  OK`);
if (connectivity.version) console.log(`  version    ${connectivity.version}`);
if (connectivity.edition) console.log(`  edition    ${connectivity.edition}`);

// --- 3. Schema -------------------------------------------------------------

heading('Schema');

let schema;
try {
  schema = await applyGraphSchema({ force: true });
} catch (error) {
  await fail(
    'Could not apply the graph schema.',
    error.message,
    error.hint ?? 'Confirm the Neo4j user has permission to create constraints.'
  );
}

for (const name of schema.applied) {
  console.log(`  applied    ${name}`);
}
for (const { name, reason } of schema.skipped) {
  console.log(`  skipped    ${name}  (${reason})`);
}

if (schema.skipped.some((s) => s.name === 'transaction_unique_id')) {
  console.log(
    '\n  Note: this Neo4j build would not accept a uniqueness constraint on the\n' +
      '  TRANSACTION relationship. That is fine - ingestion MERGEs on uniqueId, so\n' +
      '  duplicate edges are still impossible. The constraint was only a backstop.'
  );
}

// --- 4. Seed ---------------------------------------------------------------

heading('Exchange wallets');

const exchanges = listKnownExchanges();

if (exchanges.length === 0) {
  await fail(
    'The exchange registry is empty, so there is nothing to seed.',
    'Every entry in src/config/knownExchanges.js is either malformed or marked verified: false.',
    'Add at least one verified exchange address before seeding.'
  );
}

let result;
try {
  result = await seedExchangeWallets(exchanges);
} catch (error) {
  await fail('Seeding failed.', error.message, error.hint);
}

// Group for a readable report: an operator with four hot wallets should print
// as one line, not four.
const byOperator = new Map();
for (const entry of exchanges) {
  if (!byOperator.has(entry.exchange)) byOperator.set(entry.exchange, []);
  byOperator.get(entry.exchange).push(entry);
}

for (const [operator, entries] of [...byOperator.entries()].sort()) {
  const labels = entries.map((entry) => entry.label).join(', ');
  console.log(`  ${operator.padEnd(14)} ${String(entries.length).padStart(2)} wallet(s)  ${labels}`);
}

console.log('');
console.log(`  wallets seeded : ${result.seeded}`);
console.log(`  newly created  : ${result.nodesCreated}`);
console.log(`  properties set : ${result.propertiesSet}`);

if (result.skipped.length > 0) {
  console.log(`  skipped        : ${result.skipped.length}`);
  for (const entry of result.skipped) console.log(`     - ${entry}`);
}

// --- 5. Verify by reading it back ------------------------------------------
// Trusting the write counters alone would miss the case where the seed went to a
// different database than the one the server will query - which is exactly what
// happens if NEO4J_DATABASE is wrong.

heading('Verification');

const records = await runRead(
  'MATCH (w:Wallet) WHERE w.isExchange = true ' +
    'RETURN w.exchange AS exchange, count(w) AS wallets ORDER BY exchange'
);

const readBack = records.reduce((total, record) => {
  const count = record.get('wallets');
  return total + (typeof count?.toNumber === 'function' ? count.toNumber() : Number(count));
}, 0);

console.log(`  isExchange = true nodes in "${config.graph.database}" : ${readBack}`);

if (readBack < exchanges.length) {
  console.log(
    `\n  Warning: expected at least ${exchanges.length} but found ${readBack}.` +
      '\n  Check that NEO4J_DATABASE matches the database you are inspecting in Neo4j Browser.'
  );
}

const stats = await getGraphStats();
console.log(`  total wallets in graph                        : ${stats.wallets}`);
console.log(`  total TRANSACTION edges in graph              : ${stats.transactions}`);

const schemaState = await describeGraphSchema();
console.log(
  `  constraints: ${schemaState.constraints.length}   indexes: ${schemaState.indexes.length}`
);

// --- 6. Outstanding placeholders ------------------------------------------
// Repeated here, at the end, where it cannot be scrolled past. WazirX and
// CoinDCX are the most relevant venues for an MHA problem statement, and an
// unseeded WazirX means a WazirX cash-out will never be detected.

if (unverifiedExchanges.length > 0) {
  heading('Action still required');
  const many = unverifiedExchanges.length !== 1;
  console.log(
    `  ${unverifiedExchanges.length} registry entr${many ? 'ies are' : 'y is'} ` +
      `${many ? 'placeholders' : 'a placeholder'} and ${many ? 'were' : 'was'} NOT seeded:`
  );
  for (const entry of unverifiedExchanges) console.log(`     - ${entry}`);
  console.log(
    '\n  These addresses are zero-address stubs I did not guess. Until they hold real\n' +
      '  values, funds cashed out at those exchanges will not be flagged. Fill them in\n' +
      '  from Etherscan public name tags in src/config/knownExchanges.js, set\n' +
      '  verified: true, and re-run this script.'
  );
}

// --- 7. Next steps ---------------------------------------------------------

heading('Next');
console.log('  1. npm run smoke:graph      verify ingestion logic offline');
console.log('  2. npm run dev              start the server');
console.log('  3. Trace an address; it is written to Neo4j automatically:');
console.log(
  `     curl "http://localhost:${config.port}/api/history/<ADDRESS>?depth=${config.defaultTraceDepth}"`
);
console.log('  4. In Neo4j Browser, see what landed:');
console.log('     MATCH (w:Wallet)-[t:TRANSACTION]->(e:Wallet {isExchange: true}) RETURN * LIMIT 50');
console.log('');

await closeDriver();
process.exit(0);
