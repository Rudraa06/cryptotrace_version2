/**
 * routes/graph.routes.js
 * ---------------------------------------------------------------------------
 * PHASE 2 HTTP surface for the graph itself.
 *
 *   GET /api/graph/stats    what is currently in Neo4j
 *   GET /api/graph/schema   which constraints and indexes exist
 *
 * These are diagnostics, and they exist for one specific reason: when a trace
 * returns no exchange, there are two very different explanations - the money
 * never reached one, or the graph was never seeded. Guessing between those live
 * is unpleasant. `GET /api/graph/stats` answers it in one request by reporting
 * how many `isExchange` nodes exist.
 *
 * Phase 3 will add `GET /api/trace/:address` alongside these.
 */

import { Router } from 'express';

import { config } from '../config/env.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { getGraphStats } from '../services/graph.service.js';
import { describeGraphSchema } from '../services/graphSchema.js';
import { verifyGraphConnectivity } from '../services/neo4j.service.js';

export const graphRouter = Router();

/**
 * GET /api/graph/stats
 *
 * Node and edge counts, per-asset totals, and the exchanges that have received
 * the most traced value. That last one is the problem statement answered at
 * database level rather than per trace.
 */
graphRouter.get(
  '/graph/stats',
  asyncRoute(async (req, res) => {
    if (!config.graph.enabled) {
      res.status(503).json({
        ok: false,
        error: {
          code: 'GRAPH_DISABLED',
          message: 'The Neo4j graph is disabled (GRAPH_ENABLED=false).',
          hint: 'Set GRAPH_ENABLED=true in backend/.env and provide NEO4J_PASSWORD.',
        },
      });
      return;
    }

    const stats = await getGraphStats();

    // An empty graph is a valid state, but it is almost always a missed step
    // rather than an intentional one, so name the fix in the response.
    const hints = [];
    if (stats.exchangeWallets === 0) {
      hints.push(
        'No wallets are flagged isExchange, so no trace can ever identify a cash-out ' +
          'point. Run: npm run seed:exchanges'
      );
    }
    if (stats.transactions === 0) {
      hints.push('No transactions ingested yet. Run a trace: GET /api/history/:address');
    }

    res.json({
      ok: true,
      graph: stats,
      ...(hints.length > 0 ? { hints } : {}),
    });
  })
);

/**
 * GET /api/graph/schema
 *
 * The constraints and indexes actually present in the database. Useful for
 * confirming that the `uniqueId` uniqueness decision was applied, and for seeing
 * whether the optional relationship constraint was accepted by this Neo4j build.
 */
graphRouter.get(
  '/graph/schema',
  asyncRoute(async (req, res) => {
    if (!config.graph.enabled) {
      res.status(503).json({
        ok: false,
        error: {
          code: 'GRAPH_DISABLED',
          message: 'The Neo4j graph is disabled (GRAPH_ENABLED=false).',
        },
      });
      return;
    }

    const connectivity = await verifyGraphConnectivity();
    if (!connectivity.ok) {
      res.status(503).json({
        ok: false,
        error: {
          code: 'GRAPH_UNAVAILABLE',
          message: connectivity.message,
          hint: connectivity.hint,
        },
      });
      return;
    }

    const schema = await describeGraphSchema();

    res.json({
      ok: true,
      database: config.graph.database,
      version: connectivity.version,
      edition: connectivity.edition,
      // Stated explicitly so the reasoning is discoverable from the running
      // service, not just from a comment in the source.
      uniquenessModel: {
        wallet: 'Wallet.address is UNIQUE',
        transaction: 'TRANSACTION.uniqueId is UNIQUE; TRANSACTION.hash is INDEXED',
        rationale:
          'One transaction hash can contain several transfers, so hash is not a safe ' +
          'unique key - a batched payout would lose all but one of its edges. ' +
          'uniqueId identifies a single transfer.',
      },
      ...schema,
    });
  })
);
