/**
 * services/graphSchema.js
 * ---------------------------------------------------------------------------
 * PHASE 2: constraints and indexes for the CryptoTrace graph.
 *
 * Applying this is idempotent (`IF NOT EXISTS` everywhere), so it is safe to run
 * on every boot and from the seeding script.
 *
 * ===========================================================================
 * THE UNIQUENESS DECISION - WORTH READING
 * ===========================================================================
 * The original schema made `TRANSACTION.hash` unique. That is unsafe, and this
 * is the one design change in Phase 2 that alters your spec, so here is the
 * reasoning in full.
 *
 * A transaction hash identifies a TRANSACTION ON THE CHAIN, not a transfer of
 * value. One transaction routinely moves value between several pairs of
 * addresses:
 *
 *   - a contract that pays out to five recipients in one call,
 *   - a DEX swap, which emits an ERC-20 transfer AND a native transfer,
 *   - a batched withdrawal from an exchange - the exact pattern we care about.
 *
 * All of those share a single hash. With `hash` unique, the first edge would be
 * written and the rest silently rejected. In a fund-tracing tool that failure is
 * not cosmetic: the dropped edge can be the one that actually reaches the
 * exchange, so the trace would report "no cash-out found" and be wrong, quietly.
 *
 * Phase 1 already emits `uniqueId` - Alchemy's per-transfer identifier, e.g.
 * `0xabc…:log:14` - which is unique per transfer rather than per transaction.
 * So:
 *
 *   - `uniqueId`  UNIQUE  -> one graph edge per real-world transfer
 *   - `hash`      INDEXED -> `MATCH ()-[t:TRANSACTION {hash: $h}]->()` stays fast,
 *                            and returns ALL transfers in that transaction, which
 *                            is the more useful answer anyway
 *
 * You keep the queryability the spec wanted and lose the data-loss bug.
 *
 * ===========================================================================
 * A NOTE ON EDITION AND VERSION
 * ===========================================================================
 * Relationship property uniqueness constraints need a recent Neo4j 5.x. If the
 * server refuses one, `applyGraphSchema()` records it and carries on with a
 * relationship index instead - it does NOT fail the boot.
 *
 * That degradation is safe because the constraint is a second line of defence,
 * not the mechanism: `ingestToGraph` writes edges with
 * `MERGE (a)-[t:TRANSACTION {uniqueId: …}]->(b)`, and MERGE itself is what
 * guarantees one edge per transfer. The constraint only protects against a
 * future writer that forgets to do that.
 */

import { logger } from '../lib/logger.js';
import { config } from '../config/env.js';
import { withSession, fromNeoInt, GraphDisabledError } from './neo4j.service.js';

/**
 * @typedef {object} SchemaStatement
 * @property {string} name      Constraint/index name, so it can be dropped later.
 * @property {string} kind      'constraint' | 'index'
 * @property {string} purpose   Why it exists - printed by the seeding script.
 * @property {string} cypher    The 5.x statement.
 * @property {string} [fallbackCypher] Older-syntax retry, if any.
 * @property {boolean} [optional] If true, failure is logged and tolerated.
 */

/** @type {SchemaStatement[]} */
export const SCHEMA_STATEMENTS = [
  {
    name: 'wallet_address_unique',
    kind: 'constraint',
    purpose:
      'One node per address. This is the backbone of the whole graph: every ' +
      'MERGE keys on it, and the constraint also creates the index that makes ' +
      'those MERGEs fast rather than a full label scan.',
    cypher:
      'CREATE CONSTRAINT wallet_address_unique IF NOT EXISTS ' +
      'FOR (w:Wallet) REQUIRE w.address IS UNIQUE',
    // Neo4j 4.0-4.3 spelled this ASSERT. Kept because the cost is one retry and
    // the failure it prevents is a completely unindexed graph.
    fallbackCypher:
      'CREATE CONSTRAINT wallet_address_unique IF NOT EXISTS ' +
      'ON (w:Wallet) ASSERT w.address IS UNIQUE',
  },
  {
    name: 'transaction_unique_id',
    kind: 'constraint',
    purpose:
      'One edge per real-world transfer. See the header note on why this is ' +
      'uniqueId and not hash.',
    cypher:
      'CREATE CONSTRAINT transaction_unique_id IF NOT EXISTS ' +
      'FOR ()-[t:TRANSACTION]-() REQUIRE t.uniqueId IS UNIQUE',
    // Relationship uniqueness constraints are not available on every edition or
    // version; the MERGE pattern already guarantees the invariant.
    optional: true,
  },
  {
    name: 'transaction_hash',
    kind: 'index',
    purpose:
      'Look up every transfer belonging to a transaction hash - the query an ' +
      'investigator runs when cross-checking against Etherscan.',
    cypher:
      'CREATE INDEX transaction_hash IF NOT EXISTS FOR ()-[t:TRANSACTION]-() ON (t.hash)',
    optional: true,
  },
  {
    name: 'transaction_timestamp',
    kind: 'index',
    purpose:
      'Time-window filtering. Victim complaints come with a date, so "show me ' +
      'movement in this window" is a first-class query.',
    cypher:
      'CREATE INDEX transaction_timestamp IF NOT EXISTS ' +
      'FOR ()-[t:TRANSACTION]-() ON (t.timestamp)',
    optional: true,
  },
  {
    name: 'wallet_is_exchange',
    kind: 'index',
    purpose:
      'Phase 3 depends on this. shortestPath to "any node WHERE w.isExchange = ' +
      'true" has to find those endpoints without scanning every Wallet, and this ' +
      'index is what makes that difference.',
    cypher: 'CREATE INDEX wallet_is_exchange IF NOT EXISTS FOR (w:Wallet) ON (w.isExchange)',
    optional: true,
  },
  {
    name: 'wallet_exchange_name',
    kind: 'index',
    purpose: 'Group or filter results by operator, e.g. "everything that reached WazirX".',
    cypher: 'CREATE INDEX wallet_exchange_name IF NOT EXISTS FOR (w:Wallet) ON (w.exchange)',
    optional: true,
  },
  
  // ===========================================================================
  // BITCOIN / UTXO SCHEMA (PHASE 1)
  // ===========================================================================
  {
    name: 'btc_address_unique',
    kind: 'constraint',
    purpose: 'UTXO Phase 1: One node per Bitcoin address.',
    cypher: 'CREATE CONSTRAINT btc_address_unique IF NOT EXISTS FOR (a:BtcAddress) REQUIRE a.address IS UNIQUE',
    fallbackCypher: 'CREATE CONSTRAINT btc_address_unique IF NOT EXISTS ON (a:BtcAddress) ASSERT a.address IS UNIQUE',
  },
  {
    name: 'btc_output_unique',
    kind: 'constraint',
    purpose: 'UTXO Phase 1: One node per discrete UTXO (outputId = txid:vout) to avoid EVM hash-style data loss.',
    cypher: 'CREATE CONSTRAINT btc_output_unique IF NOT EXISTS FOR (o:BtcOutput) REQUIRE o.outputId IS UNIQUE',
    fallbackCypher: 'CREATE CONSTRAINT btc_output_unique IF NOT EXISTS ON (o:BtcOutput) ASSERT o.outputId IS UNIQUE',
  },
  {
    name: 'btc_output_spent',
    kind: 'index',
    purpose: 'UTXO Phase 1: Fast lookup for unspent outputs.',
    cypher: 'CREATE INDEX btc_output_spent IF NOT EXISTS FOR (o:BtcOutput) ON (o.spent)',
    optional: true,
  },
  {
    name: 'btc_output_address',
    kind: 'index',
    purpose: 'UTXO Phase 1: Fast lookup of all outputs controlled by an address.',
    cypher: 'CREATE INDEX btc_output_address IF NOT EXISTS FOR (o:BtcOutput) ON (o.address)',
    optional: true,
  },
  {
    name: 'btc_tx_unique',
    kind: 'constraint',
    purpose: 'UTXO Phase 1: One node per Bitcoin transaction.',
    cypher: 'CREATE CONSTRAINT btc_tx_unique IF NOT EXISTS FOR (t:BtcTransaction) REQUIRE t.txid IS UNIQUE',
    fallbackCypher: 'CREATE CONSTRAINT btc_tx_unique IF NOT EXISTS ON (t:BtcTransaction) ASSERT t.txid IS UNIQUE',
  },
  {
    name: 'btc_tx_blockheight',
    kind: 'index',
    purpose: 'UTXO Phase 1: Query transactions by block height.',
    cypher: 'CREATE INDEX btc_tx_blockheight IF NOT EXISTS FOR (t:BtcTransaction) ON (t.blockHeight)',
    optional: true,
  },
  {
    name: 'btc_tx_blocktime',
    kind: 'index',
    purpose: 'UTXO Phase 1: Temporal consistency checks across UTXO hops.',
    cypher: 'CREATE INDEX btc_tx_blocktime IF NOT EXISTS FOR (t:BtcTransaction) ON (t.blockTime)',
    optional: true,
  },
  {
    name: 'btc_cluster_unique',
    kind: 'constraint',
    purpose: 'UTXO Phase 2: One node per entity cluster.',
    cypher: 'CREATE CONSTRAINT btc_cluster_unique IF NOT EXISTS FOR (c:BtcCluster) REQUIRE c.clusterId IS UNIQUE',
    fallbackCypher: 'CREATE CONSTRAINT btc_cluster_unique IF NOT EXISTS ON (c:BtcCluster) ASSERT c.clusterId IS UNIQUE',
  },
  {
    name: 'btc_cluster_is_exchange',
    kind: 'index',
    purpose: 'UTXO Phase 3: Fast shortestPath target for trace queries, mirroring wallet_is_exchange.',
    cypher: 'CREATE INDEX btc_cluster_is_exchange IF NOT EXISTS FOR (c:BtcCluster) ON (c.isExchange)',
    optional: true,
  },
];

/** Set once per process so repeated calls do not re-issue schema commands. */
let applied = null;

/**
 * Create every constraint and index, tolerating the optional ones.
 *
 * Schema commands are issued as separate auto-commit statements on purpose:
 * Neo4j refuses to mix schema and data changes in one transaction, and running
 * them individually means one unsupported statement cannot roll back the rest.
 *
 * @param {{ force?: boolean }} [options] `force` re-runs even if already applied.
 * @returns {Promise<{ ok: boolean, applied: string[], skipped: Array<{name: string, reason: string}> }>}
 */
export async function applyGraphSchema(options = {}) {
  if (!config.graph.enabled) throw new GraphDisabledError();
  if (applied && !options.force) return applied;

  /** @type {string[]} */
  const appliedNames = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];

  await withSession('WRITE', async (session) => {
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        await session.run(statement.cypher);
        appliedNames.push(statement.name);
      } catch (error) {
        // Try the older syntax before giving up on a required statement.
        if (statement.fallbackCypher) {
          try {
            await session.run(statement.fallbackCypher);
            appliedNames.push(statement.name);
            logger.warn('Applied schema statement using legacy syntax', {
              name: statement.name,
              hint: 'Your Neo4j is older than 4.4. Consider upgrading to 5.x.',
            });
            continue;
          } catch {
            // Fall through to the handling below.
          }
        }

        const reason = error?.message ?? String(error);

        if (statement.optional) {
          skipped.push({ name: statement.name, reason: reason.split('\n')[0] });
          logger.warn('Optional schema statement not supported by this Neo4j; continuing', {
            name: statement.name,
            kind: statement.kind,
            reason: reason.split('\n')[0],
            impact:
              statement.name === 'transaction_unique_id'
                ? 'Edge uniqueness still enforced by MERGE on uniqueId.'
                : 'Queries still work, just without this index.',
          });
          continue;
        }

        // A required statement failed: that is fatal and must be loud.
        throw error;
      }
    }
  });

  applied = { ok: true, applied: appliedNames, skipped };

  logger.info('Graph schema applied', {
    applied: appliedNames.length,
    skipped: skipped.length,
    database: config.graph.database,
  });

  return applied;
}

/**
 * Read back what actually exists in the database.
 *
 * Used by the seeding script and `/api/graph/stats` so you can confirm the state
 * of the database rather than trusting that a migration ran at some point.
 *
 * @returns {Promise<{ constraints: Array<object>, indexes: Array<object> }>}
 */
export async function describeGraphSchema() {
  if (!config.graph.enabled) throw new GraphDisabledError();

  return withSession('READ', async (session) => {
    /** @param {string} cypher */
    const safeRun = async (cypher) => {
      try {
        const result = await session.run(cypher);
        return result.records;
      } catch {
        // SHOW CONSTRAINTS/INDEXES is 4.2+. Missing it is not worth an error.
        return [];
      }
    };

    const constraintRecords = await safeRun(
      'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties ' +
        'RETURN name, type, entityType, labelsOrTypes, properties'
    );
    const indexRecords = await safeRun(
      'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state ' +
        'RETURN name, type, entityType, labelsOrTypes, properties, state'
    );

    /** @param {any} record */
    const toObject = (record) => {
      const object = {};
      for (const key of record.keys) {
        const value = record.get(key);
        object[key] = typeof value?.toNumber === 'function' ? fromNeoInt(value) : value;
      }
      return object;
    };

    return {
      constraints: constraintRecords.map(toObject),
      indexes: indexRecords.map(toObject),
    };
  });
}

/**
 * Drop every CryptoTrace node and relationship, keeping constraints/indexes.
 *
 * Deliberately batched with CALL IN TRANSACTIONS. Deleting a large graph in one
 * transaction builds the whole undo log in memory and can OOM the database -
 * an unpleasant surprise if you reset between demo runs.
 *
 * @returns {Promise<{ deletedNodes: number }>}
 */
export async function resetGraphData() {
  if (!config.graph.enabled) throw new GraphDisabledError();

  return withSession('WRITE', async (session) => {
    // Relationships are removed along with their nodes by DETACH DELETE.
    try {
      await session.run(
        'MATCH (w:Wallet) CALL { WITH w DETACH DELETE w } IN TRANSACTIONS OF 1000 ROWS'
      );
    } catch {
      // Older syntax / smaller datasets: fall back to a single transaction.
      await session.run('MATCH (w:Wallet) DETACH DELETE w');
    }

    const check = await session.run('MATCH (w:Wallet) RETURN count(w) AS remaining');
    const remaining = fromNeoInt(check.records[0]?.get('remaining')) ?? 0;

    logger.warn('Graph data reset', { remainingWallets: remaining });
    return { deletedNodes: remaining === 0 ? -1 : remaining };
  });
}
