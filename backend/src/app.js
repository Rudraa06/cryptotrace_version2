/**
 * app.js
 * ---------------------------------------------------------------------------
 * Builds and returns the configured Express application.
 *
 * Kept separate from `server.js` (which owns the listening socket and process
 * lifecycle) so tests can import the app and exercise routes in-process without
 * binding a port.
 */

import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import RedisReal from 'ioredis';
import RedisMock from 'ioredis-mock';
import cookieParser from 'cookie-parser';

const Redis = process.env.NODE_ENV === 'test' ? RedisMock : RedisReal;

import { config, redactedConfig } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler, asyncRoute } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import { historyRouter } from './routes/history.routes.js';
import { graphRouter } from './routes/graph.routes.js';
import { traceRouter } from './routes/trace.routes.js';
import { aiRouter } from './routes/ai.routes.js';
import { complaintsRouter } from './routes/complaints.routes.js';
import { crossChainRouter } from './routes/crossChain.routes.js';
import { exportRouter } from './routes/export.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { investigatorsRouter } from './routes/investigators.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { alertRouter } from './services/alertEngine.service.js';
import { checkRpcHealth } from './services/provider.js';
import { verifyGraphConnectivity } from './services/neo4j.service.js';
import { unverifiedExchanges, listKnownExchanges } from './config/knownExchanges.js';
import { getSanctionsStatus } from './services/sanctions.service.js';
import { checkBtcIndexerHealth } from './services/btcIngestion.service.js';

/**
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();

  // Behind a reverse proxy (ngrok, Cloudflare Tunnel, a demo box) this makes
  // req.ip and req.protocol reflect the original client rather than the proxy.
  app.set('trust proxy', 1);
  // No need to advertise the framework.
  app.disable('x-powered-by');

  // --- CORS ---------------------------------------------------------------
  // Note: CORS is not an authentication mechanism. It only blocks browsers.
  // See Task 1.1 / apiKey.js middleware for the actual access control.
  // The Phase 4 Vite frontend is a different origin (5173 vs 4000), so this is
  // required, not optional. An explicit allowlist rather than `*` because we
  // want the failure to be obvious if the frontend port changes.
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: curl, Postman, server-to-server. Always allow.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin)) return callback(null, true);

        logger.warn('Blocked cross-origin request', {
          origin,
          allowed: config.corsOrigins,
          fix: 'Add this origin to CORS_ORIGINS in backend/.env',
        });
        return callback(new Error(`Origin ${origin} is not permitted by CORS_ORIGINS`));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    })
  );

  // --- Body parsing --------------------------------------------------------
  // Phase 1 is read-only, but Phase 2 will POST ingestion payloads. A small
  // limit keeps an accidental huge upload from exhausting memory.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // --- Rate Limiting -------------------------------------------------------
  const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 50, 2000);
    }
  });

  redisClient.on('error', (err) => {
    // Only log if it's not a generic refused connection to avoid spamming the terminal
    // when failing open. Rate-limit-redis relies on this error being swallowed here.
    if (err.code !== 'ECONNREFUSED') {
      logger.error('Redis connection error in rate limiter', { error: err.message });
    }
  });

  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000, // High ceiling to support frontend status polling loops
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => {
        if (typeof redisClient.call === 'function') return redisClient.call(...args);
        const command = args[0].toLowerCase();
        return redisClient[command](...args.slice(1));
      },
    }),
    passOnStoreError: true, // Fail open: if Redis is down, allow requests through rather than 500ing
    skip: (req) => req.path === '/health' || req.path.includes('/status/'),
    message: { ok: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.' } }
  });

  const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
    }),
    passOnStoreError: true, // Fail open if Redis is down
    message: { ok: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests to expensive endpoints.' } }
  });

  // Export for testing
  app.locals.redisClient = redisClient;

  app.use(globalLimiter);

  // --- Request logging -----------------------------------------------------
  // Route through our logger so output format stays consistent (and becomes JSON
  // in production alongside everything else).
  app.use(
    morgan(config.isProduction ? 'combined' : 'tiny', {
      stream: { write: (line) => logger.info(line.trimEnd()) },
      // Health checks are polled frequently and would drown the useful logs.
      skip: (req) => req.path === '/health',
    })
  );

  // --- Health --------------------------------------------------------------
  /**
   * GET /health
   *
   * Reports on both dependencies separately, and that separation is the whole
   * point. During a demo the three failure modes - my server is down, Alchemy is
   * unreachable, Neo4j is stopped - look identical from the frontend, and you do
   * not want to be working out which one it is in front of judges.
   *
   * Status is 200 only when everything the current configuration needs is up.
   * Neo4j being down while GRAPH_ENABLED=false is not a failure; Neo4j being
   * down while it is enabled is degraded, because traces will not persist.
   */
  app.get(
    '/health',
    asyncRoute(async (req, res) => {
      // Checked in parallel: two sequential timeouts would make a slow health
      // check slower than the poll interval.
      const [rpc, graph, btcIndexer] = await Promise.all([
        checkRpcHealth(),
        config.graph.enabled
          ? verifyGraphConnectivity()
          : Promise.resolve({ ok: false, enabled: false, message: 'GRAPH_ENABLED=false' }),
        checkBtcIndexerHealth(),
      ]);

      const graphHealthy = config.graph.enabled ? graph.ok : true;
      const healthy = rpc.ok && graphHealthy && btcIndexer.ok;

      const sanctions = getSanctionsStatus();

      res.status(healthy ? 200 : 503).json({
        ok: healthy,
        service: 'cryptotrace-backend',
        phase: 3,
        uptimeSeconds: Math.round(process.uptime()),
        rpc,
        btcIndexer,
        graph,
        sanctions: {
          ok: !sanctions.isUnavailable,
          lastSyncedAt: sanctions.lastSyncedAt,
          addressCount: sanctions.addressCount,
          ...(sanctions.isUnavailable
            ? { warning: 'OFAC SDN sanctions list unavailable or degraded. Screening results may be incomplete.' }
            : {}),
        },
        exchangeRegistry: {
          active: listKnownExchanges().length,
          unverifiedPlaceholders: unverifiedExchanges.length,
          // Nudge so an unverified WazirX entry cannot be forgotten.
          ...(unverifiedExchanges.length > 0
            ? { action: 'Replace placeholder addresses in src/config/knownExchanges.js' }
            : {}),
        },
      });
    })
  );

  // --- API routes ----------------------------------------------------------
  app.use('/api/auth', authRouter);
  
  // Unauthenticated routes must come before the global auth middleware
  app.use('/api', graphRouter);
  
  // Global auth wall for all remaining /api routes
  // This replaces attaching requireAuth to each individual router, which was causing 
  // the middleware (and its Neo4j isActive query) to execute up to 7 times per request
  // as Express cascaded down the matching '/api' prefixes.
  app.use('/api', requireAuth);
  
  app.use('/api', historyRouter);
  app.use('/api', traceRouter);
  app.use('/api', exportRouter);
  app.use('/api/investigators', investigatorsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api', alertRouter);

  // Domain-specific limiters on top of auth
  app.use('/api/ai', strictLimiter, aiRouter);
  app.use('/api/complaints', strictLimiter, complaintsRouter);
  app.use('/api/cross-chain', crossChainRouter);

  // --- Root banner ---------------------------------------------------------
  app.get('/', (req, res) => {
    res.json({
      service: 'cryptotrace-backend',
      description:
        'CryptoTrace — Real-time identification of fraud-linked cryptocurrency exchanges',
      phase: 3,
      config: redactedConfig(),
      routes: {
        health: 'GET /health',
        config: 'GET /api/config',
        history: 'GET /api/history/:address?depth=3',
        trace: 'GET /api/trace/:address?maxHops=15',
        graphStats: 'GET /api/graph/stats',
        graphSchema: 'GET /api/graph/schema',
      },
    });
  });

  // --- Error handling (must be registered last) ---------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
