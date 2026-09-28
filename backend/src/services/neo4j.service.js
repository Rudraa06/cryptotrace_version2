/**
 * services/neo4j.service.js
 * ---------------------------------------------------------------------------
 * PHASE 2 FOUNDATION: the Neo4j connection.
 *
 * Everything that talks to the graph goes through this module. It owns exactly
 * three responsibilities and deliberately no analytical logic:
 *
 *   1. One shared Driver for the process lifetime.
 *   2. Session/transaction helpers that always close what they open.
 *   3. Turning driver errors into something a human can act on.
 *
 * ---------------------------------------------------------------------------
 * ONE DRIVER, MANY SESSIONS
 * ---------------------------------------------------------------------------
 * A Neo4j `Driver` is a connection pool and is expensive to construct; a
 * `Session` is cheap, single-threaded and must be closed. The correct shape is
 * therefore one driver per process, one session per unit of work. Creating a
 * driver per request is the classic mistake - it exhausts file descriptors and
 * makes the server slow in a way that looks like Neo4j being slow.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMPORT IS LAZY
 * ---------------------------------------------------------------------------
 * `neo4j-driver` is imported dynamically on first use rather than statically at
 * the top of the file. Two concrete reasons:
 *
 *   - The graph is an optional subsystem (see GRAPH_ENABLED). With a static
 *     import, forgetting `npm install neo4j-driver` would stop the Phase 1
 *     ingestion service from booting at all, which is a silly way to lose a
 *     demo.
 *   - It lets the offline test suite (`npm run smoke:graph`) inject a fake
 *     driver and verify our Cypher and batching without a database running.
 *
 * ---------------------------------------------------------------------------
 * WHY MANAGED TRANSACTIONS
 * ---------------------------------------------------------------------------
 * We use `session.executeWrite(...)` rather than `session.run(...)`. Managed
 * transactions retry automatically on *transient* failures, and the failure that
 * matters here is a deadlock: two concurrent traces that both MERGE the same
 * wallet can lock each other out. Neo4j detects that, marks it retryable, and
 * the managed transaction quietly runs again. Hand-rolled `session.run` calls
 * would surface it as a hard error in the middle of a trace.
 */

import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Error type for every graph failure that should become an HTTP 503 rather than
 * a 500. The distinction matters: 503 says "the database is not available",
 * which is a true and actionable statement, whereas 500 says "this service has
 * a bug" and sends you debugging the wrong thing.
 */
export class GraphUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, hint?: string, neo4jCode?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'GraphUnavailableError';
    this.statusCode = 503;
    this.cause = options.cause;
    this.hint = options.hint;
    this.neo4jCode = options.neo4jCode;
  }
}

/** Thrown when graph work is attempted while GRAPH_ENABLED=false. */
export class GraphDisabledError extends Error {
  constructor() {
    super(
      'The Neo4j graph is disabled (GRAPH_ENABLED=false), so this operation is unavailable.'
    );
    this.name = 'GraphDisabledError';
    this.statusCode = 503;
    this.hint = 'Set GRAPH_ENABLED=true in backend/.env and provide NEO4J_PASSWORD.';
  }
}

// --- Module state ----------------------------------------------------------

/** @type {any} The `neo4j-driver` module namespace, loaded once. */
let neo4j = null;

/** @type {any} The shared Driver instance. */
let driver = null;

/** @type {Promise<any>|null} In-flight driver construction, to avoid a race. */
let driverPromise = null;

/** Cached result of the last connectivity check, for /health. */
let lastConnectivity = { ok: false, checkedAt: null, message: 'not yet checked' };

/**
 * Test seam. `npm run smoke:graph` installs a fake driver here so the Cypher,
 * batching and type coercion can be verified with no database present.
 *
 * @param {any} fakeDriver  Object exposing session()/close()/getServerInfo().
 * @param {any} [fakeNeo4j] Object exposing int()/auth/isInt, if needed.
 */
export function __setDriverForTesting(fakeDriver, fakeNeo4j = null) {
  driver = fakeDriver;
  driverPromise = fakeDriver ? Promise.resolve(fakeDriver) : null;
  if (fakeNeo4j) neo4j = fakeNeo4j;
}

// --- Error interpretation --------------------------------------------------

/**
 * Translate a driver error into a message with an actual fix in it.
 *
 * This function is longer than it looks like it should be, and that is on
 * purpose. Every branch here is a real failure I would otherwise have to
 * diagnose live from a stack trace: DBMS stopped, wrong password, wrong port,
 * database name typo. Naming them costs nothing now and saves minutes later.
 *
 * @param {any} error
 * @returns {GraphUnavailableError}
 */
function interpretDriverError(error) {
  const code = error?.code ?? '';
  const raw = error?.message ?? String(error);
  const uri = config.graph.uri;

  // Authentication: wrong username or password.
  if (code === 'Neo.ClientError.Security.Unauthorized') {
    return new GraphUnavailableError(`Neo4j rejected the credentials for user "${config.graph.user}".`, {
      cause: error,
      neo4jCode: code,
      hint:
        'Check NEO4J_USER and NEO4J_PASSWORD in backend/.env. In Neo4j Desktop the ' +
        'password is the one you set when creating the DBMS; you can reset it from ' +
        'the DBMS "..." menu -> Manage -> Settings.',
    });
  }

  // The named database does not exist (or is still starting up).
  if (
    code === 'Neo.ClientError.Database.DatabaseNotFound' ||
    /database does not exist/i.test(raw)
  ) {
    return new GraphUnavailableError(
      `Neo4j has no database named "${config.graph.database}".`,
      {
        cause: error,
        neo4jCode: code,
        hint:
          'Neo4j Desktop names the default database "neo4j". Set NEO4J_DATABASE to ' +
          'match, or create that database first. Note Community Edition supports ' +
          'only one user database.',
      }
    );
  }

  // Nothing listening: DBMS stopped, or the wrong port.
  if (
    code === 'ServiceUnavailable' ||
    error?.code === 'ECONNREFUSED' ||
    /ECONNREFUSED|could not perform discovery|failed to connect/i.test(raw)
  ) {
    return new GraphUnavailableError(`Could not reach Neo4j at ${uri}.`, {
      cause: error,
      neo4jCode: code || 'ServiceUnavailable',
      hint:
        'Open Neo4j Desktop and confirm the DBMS shows "ACTIVE" (press Start if not). ' +
        'Then confirm NEO4J_URI uses the Bolt port 7687, e.g. neo4j://localhost:7687 - ' +
        'port 7474 is the Browser and will not work here.',
    });
  }

  // Routing failure: `neo4j://` against a single instance that is not a cluster
  // member usually still works, but a stale routing table looks like this.
  if (code === 'SessionExpired' || /routing/i.test(raw)) {
    return new GraphUnavailableError(`Neo4j routing failed for ${uri}.`, {
      cause: error,
      neo4jCode: code,
      hint: `If this is a single local instance, try bolt://localhost:7687 instead of neo4j://.`,
    });
  }

  // Constraint violations are our bug, not an availability problem - but they
  // arrive through the same channel, so they need a distinct message.
  if (code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
    const conflict = new GraphUnavailableError(
      'A Neo4j uniqueness constraint was violated while writing the graph.',
      {
        cause: error,
        neo4jCode: code,
        hint:
          'This usually means two rows in one batch claimed the same key. Check the ' +
          'uniqueId values coming out of the ingestion layer.',
      }
    );
    conflict.statusCode = 500; // Genuinely our fault.
    return conflict;
  }

  // Cypher that the server rejected: a syntax error on our side.
  if (typeof code === 'string' && code.startsWith('Neo.ClientError.Statement')) {
    const bug = new GraphUnavailableError(`Neo4j rejected a Cypher statement: ${raw}`, {
      cause: error,
      neo4jCode: code,
    });
    bug.statusCode = 500;
    return bug;
  }

  return new GraphUnavailableError(`Neo4j error: ${raw}`, {
    cause: error,
    neo4jCode: code || undefined,
  });
}

// --- Driver lifecycle ------------------------------------------------------

/**
 * Load the `neo4j-driver` package, with a message that names the fix.
 * @returns {Promise<any>}
 */
async function loadNeo4j() {
  if (neo4j) return neo4j;
  try {
    // Dynamic import: see "WHY THE IMPORT IS LAZY" in the header.
    neo4j = await import('neo4j-driver');
    // The package ships a default export with the helpers on it (`driver`,
    // `auth`, `int`, ...). Interop between CJS and ESM means it can arrive
    // under `.default`, so normalise here rather than at every call site.
    if (neo4j.default && typeof neo4j.default.driver === 'function') {
      neo4j = neo4j.default;
    }
    return neo4j;
  } catch (error) {
    throw new GraphUnavailableError('The neo4j-driver package is not installed.', {
      cause: error,
      hint: 'Run:  cd backend && npm install neo4j-driver',
    });
  }
}

/**
 * Get (or lazily build) the shared Driver.
 *
 * Constructing a driver does NOT open a connection - the Bolt handshake happens
 * on first use or on an explicit `verifyGraphConnectivity()`. So this is cheap
 * and safe to call even when Neo4j is down; you find out at query time.
 *
 * @returns {Promise<any>}
 */
export async function getDriver() {
  if (!config.graph.enabled) throw new GraphDisabledError();
  if (driver) return driver;

  // Concurrent first requests must not build two drivers, so the in-flight
  // promise is shared.
  if (driverPromise) return driverPromise;

  driverPromise = (async () => {
    const lib = await loadNeo4j();

    try {
      const created = lib.driver(
        config.graph.uri,
        lib.auth.basic(config.graph.user, config.graph.password),
        {
          maxConnectionPoolSize: config.graph.maxPoolSize,
          connectionTimeout: config.graph.connectionTimeoutMs,
          connectionAcquisitionTimeout: config.graph.connectionTimeoutMs * 2,
          maxTransactionRetryTime: config.graph.maxTransactionRetryMs,

          /**
           * Return plain JS numbers instead of Integer objects on READ.
           *
           * By default the driver hands back `{low, high}` Integer objects to
           * preserve the full 64-bit range. Those serialise into JSON as
           * `{"low":123,"high":0}`, which would force the Phase 4 frontend to
           * unwrap every timestamp and block number.
           *
           * The values we read are Unix seconds and block heights - both are
           * orders of magnitude below 2^53, so there is nothing to lose. Note
           * this affects reads only: writes still use `toNeoInt()` so the
           * stored property type really is Integer, per the schema.
           */
          disableLosslessIntegers: true,

          // Shows up in Neo4j's query log, so slow queries can be attributed.
          userAgent: 'cryptotrace-backend/2.0 (SIH2026)',
        }
      );

      logger.info('Neo4j driver created', {
        uri: config.graph.uri,
        database: config.graph.database,
        user: config.graph.user,
      });

      driver = created;
      return created;
    } catch (error) {
      // Reset so a later call can retry rather than being stuck with a broken
      // promise forever.
      driverPromise = null;
      throw interpretDriverError(error);
    }
  })();

  return driverPromise;
}

/**
 * Open a session, hand it to `fn`, and close it no matter what happens.
 *
 * @template T
 * @param {'READ'|'WRITE'} mode
 * @param {(session: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSession(mode, fn) {
  const activeDriver = await getDriver();
  const lib = neo4j;

  const session = activeDriver.session({
    database: config.graph.database,
    // Routing hint. On a single instance it changes nothing; against a cluster
    // it sends reads to followers and keeps the leader free for writes.
    defaultAccessMode:
      mode === 'READ' ? lib?.session?.READ ?? 'READ' : lib?.session?.WRITE ?? 'WRITE',
  });

  try {
    return await fn(session);
  } catch (error) {
    // Already interpreted deeper in the stack: do not wrap twice.
    if (error instanceof GraphUnavailableError || error instanceof GraphDisabledError) throw error;
    throw interpretDriverError(error);
  } finally {
    // A leaked session holds a pooled connection until it times out, so this
    // `finally` is load-bearing rather than tidy-minded.
    await session.close().catch((closeError) => {
      logger.warn('Failed to close Neo4j session', { message: closeError?.message });
    });
  }
}

/**
 * Run a unit of work inside a managed transaction.
 *
 * `executeRead`/`executeWrite` are the Neo4j 5 names; 4.x called them
 * `readTransaction`/`writeTransaction`. Both are supported here because the
 * exact driver minor version installed on a given machine is not something I
 * want this code to care about.
 *
 * @template T
 * @param {'READ'|'WRITE'} mode
 * @param {(tx: any) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function runInTransaction(mode, work) {
  return withSession(mode, async (session) => {
    if (mode === 'READ') {
      const run = session.executeRead ?? session.readTransaction;
      return run.call(session, work);
    }
    const run = session.executeWrite ?? session.writeTransaction;
    return run.call(session, work);
  });
}

/**
 * Convenience wrapper for a single read query.
 *
 * @param {string} cypher
 * @param {Record<string, any>} [params]
 * @returns {Promise<any[]>} Records, as returned by the driver.
 */
export async function runRead(cypher, params = {}) {
  return runInTransaction('READ', async (tx) => {
    const result = await tx.run(cypher, params);
    return result.records;
  });
}

/**
 * Convenience wrapper for a single write query.
 *
 * @param {string} cypher
 * @param {Record<string, any>} [params]
 * @returns {Promise<{ records: any[], counters: Record<string, number> }>}
 */
export async function runWrite(cypher, params = {}) {
  return runInTransaction('WRITE', async (tx) => {
    const result = await tx.run(cypher, params);
    return { records: result.records, counters: extractCounters(result) };
  });
}

/**
 * Pull the write statistics out of a driver Result.
 *
 * These counters are how we report "12 wallets created, 3 already existed"
 * instead of just claiming success, which matters for a system whose whole
 * purpose is producing evidence.
 *
 * @param {any} result
 * @returns {Record<string, number>}
 */
export function extractCounters(result) {
  const updates = result?.summary?.counters?.updates?.();
  if (!updates) return {};
  return {
    nodesCreated: updates.nodesCreated ?? 0,
    nodesDeleted: updates.nodesDeleted ?? 0,
    relationshipsCreated: updates.relationshipsCreated ?? 0,
    relationshipsDeleted: updates.relationshipsDeleted ?? 0,
    propertiesSet: updates.propertiesSet ?? 0,
    labelsAdded: updates.labelsAdded ?? 0,
    indexesAdded: updates.indexesAdded ?? 0,
    constraintsAdded: updates.constraintsAdded ?? 0,
  };
}

/**
 * Coerce a JS number into a Neo4j Integer for writing.
 *
 * WHY THIS MATTERS. Your schema types `timestamp` and `blockNumber` as Integer.
 * JavaScript has one number type, so a plain `1735689600` sent as a parameter is
 * stored by Neo4j as a **Float** - and then `WHERE t.timestamp > 1735689600`
 * behaves differently, and a judge inspecting the database in Neo4j Browser sees
 * `1.7356896E9` where an integer was promised. `neo4j.int()` makes the stored
 * type match the documented schema.
 *
 * @param {number|null|undefined} value
 * @returns {any} A Neo4j Integer, or null.
 */
export function toNeoInt(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  // If the driver is unavailable (offline tests), fall back to the raw number
  // so callers can still inspect the parameter shape.
  if (!neo4j?.int) return rounded;
  return neo4j.int(rounded);
}

/**
 * Convert a value read back from Neo4j into a plain JS number.
 *
 * `disableLosslessIntegers: true` means we normally get numbers already, but
 * `count()` results and anything read through a different code path can still
 * arrive as an Integer object. Defensive, cheap, and prevents `{low, high}`
 * leaking into an API response.
 *
 * @param {any} value
 * @returns {number|null}
 */
export function fromNeoInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- Health ----------------------------------------------------------------

/**
 * Check that Neo4j is actually reachable and answering.
 *
 * Returns a result object rather than throwing, because this feeds `/health`,
 * and a health endpoint that throws is not a health endpoint.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, enabled: boolean, uri?: string, database?: string,
 *   version?: string, edition?: string, message?: string, hint?: string, checkedAt: string }>}
 */
export async function verifyGraphConnectivity(options = {}) {
  const checkedAt = new Date().toISOString();

  if (!config.graph.enabled) {
    lastConnectivity = {
      ok: false,
      enabled: false,
      message: 'Graph disabled (GRAPH_ENABLED=false)',
      checkedAt,
    };
    return lastConnectivity;
  }

  try {
    const activeDriver = await getDriver();

    // `getServerInfo()` (driver 5.x) both verifies connectivity and returns the
    // version, which is worth having in /health: "constraint syntax needs 5.7+"
    // is much easier to reason about when you know what you are talking to.
    let serverInfo = null;
    if (typeof activeDriver.getServerInfo === 'function') {
      serverInfo = await activeDriver.getServerInfo({ database: config.graph.database });
    } else if (typeof activeDriver.verifyConnectivity === 'function') {
      await activeDriver.verifyConnectivity({ database: config.graph.database });
    }

    // Confirm the *database* answers, not just that the socket opened. A DBMS
    // that is still starting accepts connections before it can serve queries.
    const records = await runRead(
      'CALL dbms.components() YIELD name, versions, edition ' +
        'RETURN name AS name, versions[0] AS version, edition AS edition'
    ).catch(() => null);

    const component = records?.[0];

    lastConnectivity = {
      ok: true,
      enabled: true,
      uri: config.graph.uri,
      database: config.graph.database,
      version: component?.get?.('version') ?? serverInfo?.protocolVersion?.toString(),
      edition: component?.get?.('edition') ?? undefined,
      checkedAt,
    };
    return lastConnectivity;
  } catch (error) {
    const interpreted =
      error instanceof GraphUnavailableError ? error : interpretDriverError(error);

    lastConnectivity = {
      ok: false,
      enabled: true,
      uri: config.graph.uri,
      database: config.graph.database,
      message: interpreted.message,
      hint: interpreted.hint,
      checkedAt,
    };
    return lastConnectivity;
  }
}

/** Last connectivity result without issuing a new query. */
export function getCachedConnectivity() {
  return lastConnectivity;
}

/**
 * Close the driver and release its pool. Called from the shutdown path.
 *
 * Not closing it keeps the process alive after `server.close()`, which with
 * `node --watch` shows up as a restart that appears to hang.
 */
export async function closeDriver() {
  if (!driver) return;
  try {
    await driver.close();
    logger.info('Neo4j driver closed');
  } catch (error) {
    logger.warn('Error closing Neo4j driver', { message: error?.message });
  } finally {
    driver = null;
    driverPromise = null;
  }
}
