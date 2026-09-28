import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { logger } from '../lib/logger.js';

// Setup Redis connection for BullMQ
const connection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
});

export const traceQueue = new Queue('traceQueue', { connection });
export const ingestQueue = new Queue('ingestQueue', { connection });
