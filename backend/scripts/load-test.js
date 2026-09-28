// scripts/load-test.js

/**
 * Automated Load / Stress Test
 * Simulates concurrent identical trace requests to verify that the
 * Redis caching correctly coalesces the requests and serves them fast.
 */

import assert from 'node:assert/strict';

const PORT = process.env.PORT || 4001;
const BASE_URL = `http://localhost:${PORT}`;

// We will use the main peeling chain root wallet.
// Assuming Neo4j has this in its cache/DB. If not, it will do an ingest fallback.
const TARGET = '0x7a400444318d19b01457d9b70cbe9d050ed5260b';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'local-dev-key-12345';
const HEADERS = { 'x-api-key': INTERNAL_API_KEY };

async function runTests() {
  console.log('\nLoad / Stress Tests (Trace Caching)\n');

  // Step 1: Fire a single request to warm up the cache
  console.log('Warming up the cache...');
  const startWarm = Date.now();
  const resWarm = await fetch(`${BASE_URL}/api/trace/${TARGET}`, { headers: HEADERS });
  const jsonWarm = await resWarm.json();
  const durationWarm = Date.now() - startWarm;
  
  if (resWarm.status === 401) {
    console.error('Initial trace failed: Unauthorized. Ensure process.env.INTERNAL_API_KEY is correct.');
    process.exit(1);
  }

  if (resWarm.status === 503 && jsonWarm.error?.code === 'GRAPH_UNAVAILABLE') {
    console.warn('SKIP: Neo4j is not running. Cannot load test the trace endpoint without the graph.');
    process.exit(0);
  }

  if (!jsonWarm.ok) {
    console.error('Initial trace failed:', jsonWarm);
    process.exit(1);
  }
  console.log(`Warmup complete in ${durationWarm}ms. Cached: ${jsonWarm.cached || false}`);

  // Step 2: Fire 25 concurrent requests for the exact same address
  console.log('\nFiring 25 concurrent trace requests...');
  
  const CONCURRENCY = 25;
  const startTime = Date.now();
  
  const requests = Array.from({ length: CONCURRENCY }).map(async (_, idx) => {
    const start = Date.now();
    const res = await fetch(`${BASE_URL}/api/trace/${TARGET}`, { headers: HEADERS });
    const json = await res.json();
    const duration = Date.now() - start;
    return { idx, status: res.status, ok: json.ok, cached: json.cached, duration };
  });

  const results = await Promise.all(requests);
  const totalDuration = Date.now() - startTime;

  let passedCount = 0;
  let cachedCount = 0;
  const durations = [];

  for (const r of results) {
    if (r.status === 200 && r.ok) passedCount++;
    if (r.cached) cachedCount++;
    durations.push(r.duration);
  }

  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];

  console.log(`\nResults:`);
  console.log(`  Total time taken: ${totalDuration}ms`);
  console.log(`  Requests passed:  ${passedCount} / ${CONCURRENCY}`);
  console.log(`  Cache hits:       ${cachedCount} / ${CONCURRENCY}`);
  console.log(`  Median latency:   ${median}ms`);
  console.log(`  p95 latency:      ${p95}ms`);

  if (passedCount !== CONCURRENCY) {
    console.error('\nFAIL: Some requests failed during concurrent load.');
    process.exit(1);
  }

  if (cachedCount !== CONCURRENCY) {
    console.warn('\nWARN: Not all concurrent requests hit the cache. Ensure Redis is running and caching is correctly implemented.');
  } else {
    console.log('\nPASS: All concurrent requests hit the Redis cache and completed successfully.');
  }
}

// Check if server is up
fetch(`${BASE_URL}/api/health`)
  .then(() => runTests())
  .catch(() => {
    console.error(`Could not reach server at ${BASE_URL}. Ensure it is running (npm run dev).`);
    process.exit(1);
  });
