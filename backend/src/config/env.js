/**
 * config/env.js
 * ---------------------------------------------------------------------------
 * Single source of truth for runtime configuration.
 *
 * Design rule: the process should fail loudly at boot if it is misconfigured,
 * rather than throwing a confusing `undefined` deep inside an RPC call twenty
 * minutes into a demo. Everything is parsed, coerced and validated exactly
 * once, here.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve .env relative to the backend package root, not the cwd. This means
// `node src/server.js` and `npm start --prefix backend` behave identically.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

/**
 * Collects validation problems so we can report them all at once.
 * @type {Array<{ subsystem: 'core'|'rpc'|'graph', message: string }>}
 */
const problems = [];

/**
 * Record a validation problem against a subsystem.
 *
 * The tagging matters for entry points that only use part of the config.
 * `scripts/seed-exchanges.js` talks to Neo4j and never touches the chain, so
 * refusing to run it without an Alchemy key would block a perfectly reasonable
 * "set up the database first, get the API key later" order of work - and it would
 * do so with a message about RPC endpoints, while the user is trying to seed a
 * database. `assertConfigValid({ only: ['core', 'graph'] })` avoids that.
 *
 * @param {string} message
 * @param {'core'|'rpc'|'graph'} [subsystem]
 */
function problem(message, subsystem = 'core') {
  problems.push({ subsystem, message });
}

/**
 * Read a required string.
 * @param {string} key
 * @param {{ allowEmpty?: boolean }} [opts]
 */
function str(key, fallback = undefined, { required = false } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (required) problem(`${key} is required but was not set`);
    return fallback;
  }
  return raw.trim();
}

/**
 * Read an integer with bounds checking.
 * Anything unparseable is a configuration bug, so we record it rather than
 * silently falling back — silent fallbacks are how demos mysteriously ingest
 * one hop instead of three.
 */
function int(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    problem(`${key} must be an integer, received "${raw}"`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    problem(`${key} must be between ${min} and ${max}, received ${parsed}`);
    return fallback;
  }
  return parsed;
}

/** Read a float with bounds checking. */
function float(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    problem(`${key} must be a number, received "${raw}"`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    problem(`${key} must be between ${min} and ${max}, received ${parsed}`);
    return fallback;
  }
  return parsed;
}

/** Read a boolean. Accepts true/1/yes/on (case-insensitive) as true. */
function bool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return /^(true|1|yes|on)$/i.test(raw.trim());
}

/** Read a comma-separated list, trimming blanks. */
function list(key, fallback = []) {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Assemble config -------------------------------------------------------

const NODE_ENV = str('NODE_ENV', 'development');
const MOCK_MODE = bool('MOCK_MODE', false);

const ALCHEMY_API_KEY = str('ALCHEMY_API_KEY', '');
const ALCHEMY_NETWORK = str('ALCHEMY_NETWORK', 'eth-mainnet');
const RPC_URL_OVERRIDE = str('RPC_URL', '');

/**
 * Build the effective RPC URL.
 * An explicit RPC_URL wins so the same build can point at Infura, a local
 * Erigon archive node, or Anvil without code changes.
 */
function resolveRpcUrl() {
  if (RPC_URL_OVERRIDE) return RPC_URL_OVERRIDE;
  if (!ALCHEMY_API_KEY) return '';
  return `https://${ALCHEMY_NETWORK}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

const RPC_URL = resolveRpcUrl();

// In mock mode we never touch the network, so credentials are genuinely
// optional. In live mode, missing credentials is fatal.
if (!MOCK_MODE && !RPC_URL) {
  problem(
    'No RPC endpoint configured. Set ALCHEMY_API_KEY (and optionally ' +
    'ALCHEMY_NETWORK), or set RPC_URL directly, or run with MOCK_MODE=true.',
    'rpc'
  );
}

const DEFAULT_TRACE_DEPTH = int('DEFAULT_TRACE_DEPTH', 3, { min: 1, max: 20 });
const MAX_TRACE_DEPTH = int('MAX_TRACE_DEPTH', 5, { min: 1, max: 20 });

if (DEFAULT_TRACE_DEPTH > MAX_TRACE_DEPTH) {
  problem(
    `DEFAULT_TRACE_DEPTH (${DEFAULT_TRACE_DEPTH}) cannot exceed MAX_TRACE_DEPTH (${MAX_TRACE_DEPTH})`
  );
}

// --- Phase 2: Neo4j -------------------------------------------------------
//
// The graph is treated as an OPTIONAL SUBSYSTEM, and that is a deliberate
// decision rather than laziness. If Neo4j is not running, a trace can still be
// fetched from the chain and shown - degraded, but useful. If Neo4j were a hard
// dependency, a stopped DBMS would turn a working demo into a blank screen.
// `GRAPH_ENABLED=false` is the explicit off switch for that situation.

const GRAPH_ENABLED = bool('GRAPH_ENABLED', true);

const NEO4J_URI = str('NEO4J_URI', 'neo4j://localhost:7687');
const NEO4J_USER = str('NEO4J_USER', 'neo4j');
const NEO4J_PASSWORD = str('NEO4J_PASSWORD', '');
// Neo4j 4+ is multi-database; Desktop names the default database `neo4j`.
const NEO4J_DATABASE = str('NEO4J_DATABASE', 'neo4j');

/** URI schemes the Bolt driver understands. Anything else is a typo. */
const VALID_NEO4J_SCHEMES = [
  'neo4j://',
  'neo4j+s://',
  'neo4j+ssc://',
  'bolt://',
  'bolt+s://',
  'bolt+ssc://',
];

if (GRAPH_ENABLED) {
  if (!NEO4J_PASSWORD) {
    problem(
      'NEO4J_PASSWORD is required when GRAPH_ENABLED=true. Set the password you ' +
      'chose when creating the local DBMS in Neo4j Desktop, or set ' +
      'GRAPH_ENABLED=false to run without the graph.',
      'graph'
    );
  } else if (NODE_ENV === 'production') {
    const weakPasswords = ['12345678', 'password', 'neo4j', 'admin123', 'qwerty'];
    if (NEO4J_PASSWORD.length < 12 || weakPasswords.includes(NEO4J_PASSWORD.toLowerCase())) {
      problem(
        'NEO4J_PASSWORD is too weak for production. Must be at least 12 characters ' +
        'and not in the common blocklist. This is a fatal startup error.',
        'graph'
      );
    }
  }
  if (!VALID_NEO4J_SCHEMES.some((scheme) => NEO4J_URI.startsWith(scheme))) {
    problem(
      `NEO4J_URI must start with one of ${VALID_NEO4J_SCHEMES.join(', ')} - received "${NEO4J_URI}". ` +
      'A local Neo4j Desktop DBMS is usually neo4j://localhost:7687. ' +
      'Note this is the BOLT port (7687), not the Browser port (7474).',
      'graph'
    );
  }
  // Pasting the Browser URL instead of the Bolt URL is the single most common
  // first-run mistake, and the resulting error is otherwise cryptic.
  if (/:7474(\/|$)/.test(NEO4J_URI)) {
    problem(
      'NEO4J_URI points at port 7474, which is the Neo4j Browser (HTTP) port. ' +
      'The driver needs the Bolt port: neo4j://localhost:7687',
      'graph'
    );
  }
}

export const config = Object.freeze({
  env: NODE_ENV,
  isProduction: NODE_ENV === 'production',
  port: int('PORT', 4000, { min: 1, max: 65535 }),
  corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173']),
  internalApiKey: str('INTERNAL_API_KEY', undefined, { required: true }),

  // --- RPC ---
  mockMode:     MOCK_MODE,
  rpcUrl:       RPC_URL,
  network:      ALCHEMY_NETWORK,
  alchemyApiKey: ALCHEMY_API_KEY,         // exposed for secondary chain providers
  multiChainEnabled: bool('MULTI_CHAIN_ENABLED', false),
  /** True when the endpoint is Alchemy and therefore supports enhanced APIs. */
  supportsAssetTransfers: /alchemy\.com/i.test(RPC_URL) || MOCK_MODE,

  // --- Traversal tuning ---
  defaultTraceDepth: DEFAULT_TRACE_DEPTH,
  maxTraceDepth: MAX_TRACE_DEPTH,
  maxFanoutPerAddress: int('MAX_FANOUT_PER_ADDRESS', 12, { min: 1, max: 200 }),
  maxTransfersPerAddress: int('MAX_TRANSFERS_PER_ADDRESS', 250, { min: 1, max: 10_000 }),
  maxAddressesPerTrace: int('MAX_ADDRESSES_PER_TRACE', 400, { min: 1, max: 20_000 }),

  minNativeValue: float('MIN_NATIVE_VALUE', 0.001, { min: 0 }),
  minStableValue: float('MIN_STABLE_VALUE', 1, { min: 0 }),

  /**
   * Rough USD value of one native coin. Used ONLY to rank outgoing branches
   * against each other when applying the fan-out cap, so that 0.4 ETH is
   * correctly treated as larger than 100 USDT. Never used in reported amounts.
   */
  nativeUsdHint: float('NATIVE_USD_HINT', 3000, { min: 0 }),

  includeInternalTransfers: bool('INCLUDE_INTERNAL_TRANSFERS', false),

  // --- Resilience ---
  rpcConcurrency: int('RPC_CONCURRENCY', 4, { min: 1, max: 64 }),
  rpcMaxRetries: int('RPC_MAX_RETRIES', 5, { min: 0, max: 15 }),
  rpcBaseBackoffMs: int('RPC_BASE_BACKOFF_MS', 400, { min: 10, max: 30_000 }),

  // --- Phase 2: Neo4j graph ---
  graph: Object.freeze({
    enabled: GRAPH_ENABLED,
    uri: NEO4J_URI,
    database: NEO4J_DATABASE,
    user: NEO4J_USER,
    password: NEO4J_PASSWORD,
    maxPoolSize: int('NEO4J_MAX_POOL_SIZE', 25, { min: 1, max: 200 }),
    connectionTimeoutMs: int('NEO4J_CONNECTION_TIMEOUT_MS', 15_000, { min: 1000 }),

    /**
     * Rows per write transaction. 500 keeps each transaction small enough to
     * commit quickly and to fit comfortably in the default page cache, while
     * still being far cheaper than one transaction per row. A 400-address trace
     * therefore commits in a handful of round trips rather than thousands.
     */
    batchSize: int('GRAPH_BATCH_SIZE', 500, { min: 1, max: 10_000 }),

    /** Bolt connection pool size. Well above our own concurrency on purpose. */
    maxPoolSize: int('NEO4J_MAX_POOL_SIZE', 50, { min: 1, max: 500 }),

    /** How long to wait for a TCP connection before failing. */
    connectionTimeoutMs: int('NEO4J_CONNECTION_TIMEOUT_MS', 5_000, {
      min: 500,
      max: 120_000,
    }),

    /**
     * Ceiling on the driver's own retry-on-transient loop. Deadlocks between
     * concurrent MERGEs on the same wallet are transient and retried by the
     * driver automatically; this bounds how long that can go on.
     */
    maxTransactionRetryMs: int('NEO4J_MAX_TX_RETRY_MS', 15_000, {
      min: 1_000,
      max: 120_000,
    }),

    /**
     * Apply constraints and indexes automatically on first connection.
     * Convenient for a hackathon; you would normally run migrations explicitly,
     * which is what `npm run seed:exchanges` does.
     */
    autoMigrate: bool('GRAPH_AUTO_MIGRATE', true),
  }),

  // --- Phase 3: AI Copilot ---
  geminiApiKey: str('GEMINI_API_KEY', ''),

  paths: {
    root: PACKAGE_ROOT,
    fixtures: path.join(PACKAGE_ROOT, 'fixtures'),
  },
});

/**
 * Abort startup if configuration is invalid.
 * Called explicitly from server.js so that importing this module (e.g. in a
 * unit test) never kills the process as a side effect.
 *
 * @param {{ only?: Array<'core'|'rpc'|'graph'> }} [options]
 *   Restrict validation to the subsystems this entry point actually uses.
 *   Defaults to all of them, so `server.js` keeps validating everything.
 */
export function assertConfigValid(options = {}) {
  const only = options.only ?? ['core', 'rpc', 'graph'];
  const relevant = problems.filter((p) => only.includes(p.subsystem));

  if (relevant.length === 0) return;

  const message = [
    'Invalid configuration - refusing to start:',
    ...relevant.map((p) => `  - ${p.message}`),
    '',
    'Fix your backend/.env file (copy backend/.env.example as a starting point).',
  ].join('\n');
  throw new Error(message);
}

/** Config summary that is safe to log (secrets redacted). */
export function redactedConfig() {
  return {
    env: config.env,
    port: config.port,
    mockMode: config.mockMode,
    network: config.network,
    rpcUrl: config.rpcUrl ? config.rpcUrl.replace(/\/v2\/.*$/, '/v2/***') : '(none)',
    defaultTraceDepth: config.defaultTraceDepth,
    maxTraceDepth: config.maxTraceDepth,
    maxFanoutPerAddress: config.maxFanoutPerAddress,
    rpcConcurrency: config.rpcConcurrency,
    includeInternalTransfers: config.includeInternalTransfers,
    graph: {
      enabled: config.graph.enabled,
      // Password is never included, not even masked-with-length.
      uri: config.graph.uri,
      user: config.graph.user,
      database: config.graph.database,
      batchSize: config.graph.batchSize,
    },
  };
}
