/**
 * services/progress.service.js
 * ---------------------------------------------------------------------------
 * Internal Event Emitter for routing trace progress events to SSE endpoints.
 * 
 * TRADEOFF NOTE (Pub/Sub vs In-Memory):
 * For the hackathon scope and current architecture, this uses a simple Node.js 
 * EventEmitter. This implies that the SSE stream endpoint and the background 
 * job processing the trace must be running on the same Node process. 
 * If the backend is scaled horizontally across multiple instances (e.g. via 
 * Kubernetes or PM2 cluster mode), this would need to be swapped with Redis 
 * Pub/Sub (ioredis `subscribe`/`publish`) so the SSE connection on Instance A 
 * can receive progress events from the background job running on Instance B.
 */

import { EventEmitter } from 'node:events';

/** 
 * Global event bus for trace progress.
 * High maxListeners because many users might trace simultaneously.
 */
export const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(100);

// Cache the last event for each job to prevent race conditions when clients connect late
const lastEvents = new Map();

/**
 * Get the most recent event for a job
 */
export function getLastEvent(jobId) {
  return lastEvents.get(jobId);
}

/**
 * Emit a progress update for a specific job.
 * 
 * @param {string} jobId 
 * @param {string} stage e.g. 'fetching_history', 'ingesting', 'pathfinding'
 * @param {string} message User-facing description
 * @param {string} [detail] Optional granular detail (e.g. '500 nodes')
 */
export function reportProgress(jobId, stage, message, detail = null) {
  const event = {
    stage,
    message,
    detail,
    timestamp: Date.now()
  };
  lastEvents.set(jobId, event);
  progressEmitter.emit(`progress:${jobId}`, event);
}
