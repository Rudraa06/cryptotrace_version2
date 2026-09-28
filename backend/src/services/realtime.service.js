import Redis from 'ioredis';
import { WebSocketServer } from 'ws';
import { logger } from '../lib/logger.js';
import { config } from '../config/env.js'; // Assuming REDIS_URL or defaults to localhost

// Configure Redis to not infinitely retry on Windows machines without Redis installed
const redisOptions = {
  retryStrategy(times) {
    if (times > 3) {
      logger.warn('Redis connection failed after 3 retries. Real-time cross-case alerts will be disabled.');
      return null; // Stop retrying
    }
    return Math.min(times * 50, 2000);
  }
};

// Publisher for emitting alerts
const publisher = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', redisOptions);
// Subscriber for receiving alerts in the WS server
const subscriber = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', redisOptions);

// Prevent unhandled promise rejections from flooding the terminal
publisher.on('error', () => {});
subscriber.on('error', () => {});

const CHANNEL_NAME = 'cross_case_alerts';

/**
 * Publish a cross-case alert to Redis.
 * @param {object} alertData 
 */
export function publishCrossCaseAlert(alertData) {
  try {
    const message = JSON.stringify(alertData);
    publisher.publish(CHANNEL_NAME, message).then(() => {
      logger.info('Published cross-case alert to Redis', { channel: CHANNEL_NAME });
    }).catch(err => {
      if (err.message && !err.message.includes('Connection is closed')) {
        logger.error('Failed to publish alert to Redis', { error: err.message });
      }
    });
  } catch (error) {
    logger.error('Failed to serialize alert for Redis', { error: error.message });
  }
}

/**
 * Initialize the WebSocket server and attach it to the Express HTTP server.
 * Subscribes to the Redis channel and broadcasts messages to all connected WS clients.
 * @param {import('http').Server} server 
 */
export function initializeWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    logger.info('New WebSocket client connected for real-time alerts');
    
    ws.on('error', (err) => logger.error('WebSocket Error', { error: err.message }));
    
    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
    });
  });

  // Subscribe to Redis
  subscriber.subscribe(CHANNEL_NAME).then((count) => {
    logger.info('Subscribed to Redis channel', { channel: CHANNEL_NAME, count });
  }).catch((err) => {
    if (err.message && err.message.includes('Connection is closed')) {
      logger.debug('Redis subscription skipped (connection closed)');
    } else {
      logger.error('Failed to subscribe to Redis channel', { channel: CHANNEL_NAME, error: err.message });
    }
  });

  subscriber.on('message', (channel, message) => {
    if (channel === CHANNEL_NAME) {
      logger.info('Received alert from Redis, broadcasting to WS clients', { clientsCount: wss.clients.size });
      
      wss.clients.forEach((client) => {
        if (client.readyState === 1 /* WebSocket.OPEN */) {
          client.send(message);
        }
      });
    }
  });
}
