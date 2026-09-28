/**
 * server.js
 * ---------------------------------------------------------------------------
 * Process entry point: validate configuration, bind the port, and shut down
 * cleanly.
 *
 * The graceful-shutdown handling here is not ceremony. `npm run dev` uses
 * `node --watch`, which restarts on every save; without proper teardown you
 * accumulate zombie listeners and start seeing EADDRINUSE mid-development,
 * which is a bad thing to be debugging the night before a submission.
 */

import { createApp } from './app.js';
import { assertConfigValid, config, redactedConfig } from './config/env.js';
import { logger } from './lib/logger.js';
import { destroyProvider } from './services/provider.js';
import { closeDriver, verifyGraphConnectivity } from './services/neo4j.service.js';
import { applyGraphSchema } from './services/graphSchema.js';
import { ensureGlobalAdmin } from './services/admin.service.js';
import { initializeWebSocket } from './services/realtime.service.js';
import { startSanctionsSyncJob } from './services/sanctions.service.js';

// --- Fail fast on bad configuration ---------------------------------------
try {
  assertConfigValid();
} catch (error) {
  // Deliberately console.error, not logger.error: the logger imports config,
  // and if config is what is broken we want the plainest possible output.
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

const app = createApp();

/**
 * Check Neo4j once at boot and apply the schema.
 *
 * Deliberately NOT fatal. A stopped DBMS should degrade the service, not prevent
 * it starting - the chain-ingestion half still works and is still worth having
 * on screen. But it must be loud, because silently not persisting traces is the
 * kind of thing you discover an hour later.
 */
async function initialiseGraph() {
  if (!config.graph.enabled) {
    logger.warn('GRAPH_ENABLED=false - traces will not be written to Neo4j');
    return;
  }

  const connectivity = await verifyGraphConnectivity();

  if (!connectivity.ok) {
    logger.error('Neo4j is NOT available - traces will not be persisted. Will keep trying in the background.', {
      uri: config.graph.uri,
      database: config.graph.database,
      reason: connectivity.message,
      fix: connectivity.hint,
    });
    
    const intervalId = setInterval(async () => {
      if (shuttingDown) {
        clearInterval(intervalId);
        return;
      }
      const retryConnectivity = await verifyGraphConnectivity();
      if (retryConnectivity.ok) {
        clearInterval(intervalId);
        logger.info('Neo4j connected', {
          uri: config.graph.uri,
          database: config.graph.database,
          version: retryConnectivity.version,
          edition: retryConnectivity.edition,
        });
        if (config.graph.autoMigrate) {
          try {
            const schema = await applyGraphSchema();
            logger.info('Graph schema ready', {
              applied: schema.applied.length,
              skipped: schema.skipped.length,
            });
            await ensureGlobalAdmin();
          } catch (error) {
            logger.error('Could not apply the graph schema', {
              message: error?.message,
              fix: error?.hint ?? 'Check that the Neo4j user may create constraints.',
            });
          }
        }
      }
    }, 10000);
    return;
  }

  logger.info('Neo4j connected', {
    uri: config.graph.uri,
    database: config.graph.database,
    version: connectivity.version,
    edition: connectivity.edition,
  });

  if (!config.graph.autoMigrate) return;

  try {
    const schema = await applyGraphSchema();
    logger.info('Graph schema ready', {
      applied: schema.applied.length,
      skipped: schema.skipped.length,
    });
    await ensureGlobalAdmin();
  } catch (error) {
    logger.error('Could not apply the graph schema', {
      message: error?.message,
      fix: error?.hint ?? 'Check that the Neo4j user may create constraints.',
    });
  }
}

const server = app.listen(config.port, () => {
  logger.info('CryptoTrace backend listening', redactedConfig());

  if (config.mockMode) {
    logger.warn(
      'MOCK_MODE is ON - serving fixture data, not live blockchain data. ' +
        'Set MOCK_MODE=false in backend/.env for real traces.'
    );
  }

  // Printed rather than logged so it stands out when you start the server.
  const base = `http://localhost:${config.port}`;
  console.log('');
  console.log(`  Health : ${base}/health`);
  console.log(`  Config : ${base}/api/config`);
  console.log(`  Trace  : ${base}/api/history/<address>?depth=${config.defaultTraceDepth}`);
  console.log(`  Graph  : ${base}/api/graph/stats`);
  console.log('');

  // Runs after the socket is bound, so a slow or absent Neo4j never delays the
  // server becoming reachable.
  void initialiseGraph();

  // Start OFAC SDN sanctions screening background sync job.
  // Fetches the list immediately on boot, then refreshes every 24 hours.
  // A failed fetch on first boot loads a minimal seed list and marks the
  // service degraded — see sanctions.service.js for the full safety net.
  startSanctionsSyncJob();

  // Attach WebSocket server for real-time alerts
  initializeWebSocket(server);
});

// A clear message beats a raw stack trace for the one startup error you will
// actually hit repeatedly.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use`, {
      fix: 'Stop the other process, or change PORT in backend/.env',
    });
    process.exit(1);
  }
  logger.error('HTTP server error', { message: error.message, code: error.code });
  process.exit(1);
});

// --- Graceful shutdown -----------------------------------------------------

let shuttingDown = false;

/** @param {string} signal */
function shutdown(signal) {
  // Two Ctrl-C presses should not trigger two overlapping shutdowns.
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`${signal} received, shutting down`);

  // Stop accepting new connections, then wait for in-flight requests to finish.
  server.close(async (error) => {
    if (error) {
      logger.error('Error while closing HTTP server', { message: error.message });
    }
    destroyProvider();
    // The Bolt pool keeps the event loop alive, so an unclosed driver turns a
    // `node --watch` restart into a hang that looks like a crash.
    await closeDriver();
    logger.info('Shutdown complete');
    process.exit(error ? 1 : 0);
  });

  // Backstop: a hung keep-alive socket must not block the restart forever.
  setTimeout(() => {
    logger.warn('Forcing exit after 10s shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Last-resort safety nets ----------------------------------------------
// These should never fire; if one does it is a bug worth seeing in full rather
// than a silent process death.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception - exiting', { message: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
