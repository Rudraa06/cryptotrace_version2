// scripts/test-security.js

/**
 * Automated Security Integration Test
 * Verifies that the API Key requirement and Rate Limiting constraints
 * act as expected at the Express boundary.
 */

import assert from 'node:assert/strict';

const PORT = process.env.PORT || 4001;
const BASE_URL = `http://localhost:${PORT}`;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'local-dev-key-12345';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

async function runTests() {
  console.log('\nSecurity Integration Tests\n');

  // Test 1: Missing API Key on internal route
  await check('Internal route rejects requests with missing API key (401)', async () => {
    const res = await fetch(`${BASE_URL}/api/history/0x7a400444318d19b01457d9b70cbe9d050ed5260b`);
    assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
  });

  // Test 2: Invalid API Key on internal route
  await check('Internal route rejects requests with invalid API key (401)', async () => {
    const res = await fetch(`${BASE_URL}/api/history/0x7a400444318d19b01457d9b70cbe9d050ed5260b`, {
      headers: { 'x-api-key': 'wrong-key' }
    });
    assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
  });

  // Test 3: Valid API Key on internal route (even if wallet not found)
  await check('Internal route accepts valid API key (does not return 401)', async () => {
    const res = await fetch(`${BASE_URL}/api/history/0x7a400444318d19b01457d9b70cbe9d050ed5260b`, {
      headers: { 'x-api-key': INTERNAL_API_KEY }
    });
    // Can be 200, 400, or 404, but definitely not 401
    assert.notEqual(res.status, 401, `Expected non-401, got ${res.status}`);
  });

  // Test 4: Rate Limiting
  await check('Global rate limiter returns 429 when thresholds are exceeded', async () => {
    let got429 = false;
    
    // Fire off 150 requests immediately (limit is 100/15m)
    const requests = Array.from({ length: 150 }).map(() =>
      fetch(`${BASE_URL}/api/health`).catch(() => ({ status: 500 }))
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }

    assert.ok(got429, 'Expected at least one request to be rejected with 429 Too Many Requests');
  });

  console.log(`\n${failures.length} FAILED, ${passed} PASSED`);
  process.exit(failures.length > 0 ? 1 : 0);
}

// Check if server is up
fetch(`${BASE_URL}/api/health`)
  .then(() => runTests())
  .catch(() => {
    console.error(`Could not reach server at ${BASE_URL}. Ensure it is running (npm run dev).`);
    process.exit(1);
  });
