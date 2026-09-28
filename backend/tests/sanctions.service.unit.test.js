/**
 * tests/sanctions.service.unit.test.js
 *
 * Source-level contract tests for sanctions.service.js in isolation.
 * NO mock of sanctions.service itself — we are testing the real module.
 *
 * Kept separate from sanctions.coldstart.test.js because that file registers
 * a top-level jest.unstable_mockModule for sanctions.service (required so
 * enrichTraceGraph gets a controllable double). That mock intercepts every
 * import of the service in the same Jest worker, so we cannot reach the real
 * module from there.
 *
 * Every test in this file makes an unconditional assertion on every run.
 * There are no conditional skips. The __resetForTests() hook guarantees
 * deterministic state regardless of module-load order across the test suite.
 */

import {
  isSanctioned,
  getSanctionsStatus,
  __resetForTests,
} from '../src/services/sanctions.service.js';

// Force NODE_ENV=test so the guard inside __resetForTests() permits the call.
// Jest does not set this automatically in ESM mode.
process.env.NODE_ENV = 'test';

// Restore cold-start state before every test so the assertions are unconditional
// and independent of module-load order across the full test suite.
beforeEach(() => {
  __resetForTests();
});

describe('sanctions.service.js — source-level contract', () => {

  // --- Test 1: cold-start null contract (the regression) -------------------

  test('isSanctioned() returns null (not false) in cold-start state', () => {
    // __resetForTests() guarantees isUnavailable=true here — no conditional.
    const status = getSanctionsStatus();
    expect(status.isUnavailable).toBe(true); // confirm precondition

    const result = isSanctioned('0xAnyAddress');

    // The contract: null = unknown (list not loaded), NEVER false = confirmed clean.
    // This is the exact regression: old code returned false via Set.has() on
    // an empty set. Fixed code checks isUnavailable first.
    expect(result).toBeNull();
    expect(result).not.toBe(false);
  });

  // --- Test 2: shape contract -----------------------------------------------

  test('getSanctionsStatus() returns the expected shape', () => {
    const status = getSanctionsStatus();
    expect(status).toHaveProperty('isUnavailable');
    expect(status).toHaveProperty('lastSyncedAt');
    expect(status).toHaveProperty('addressCount');
    expect(typeof status.isUnavailable).toBe('boolean');
    expect(typeof status.addressCount).toBe('number');
    // Cold-start defaults: unavailable, no date, zero addresses
    expect(status.isUnavailable).toBe(true);
    expect(status.lastSyncedAt).toBeNull();
    expect(status.addressCount).toBe(0);
  });

  // --- Test 3: real case-insensitive matching via seeded post-sync state ----
  //
  // Previous version of this test was titled "case-insensitive after list loads"
  // but beforeEach reset to cold-start, so both inputs returned null trivially
  // (the isUnavailable guard fired before Set.has() was ever called).
  // That test covered cold-start behaviour, not matching — and duplicated Test 1.
  //
  // This version seeds a known address and sets simulateLoaded=true, which
  // makes isUnavailable=false and allows isSanctioned() to reach Set.has().
  // The real .toLowerCase()-on-write (in the hook) and .toLowerCase()-on-read
  // (in isSanctioned) are both exercised by the three assertions below.

  test('isSanctioned() matches regardless of EVM address casing after list loads', () => {
    const lowercaseAddress = '0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c';
    const checksumAddress  = '0x8576aCc5c05D6Ce88F4E49BF65BdF0C62f91353C'; // same address, mixed case
    const unrelatedAddress = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    // Seed the lowercase form and simulate a completed OFAC sync.
    // __resetForTests lowercases on write (mirrors syncOfacList), so the Set
    // contains '0x8576acc5...' and nothing else.
    __resetForTests({
      seedAddresses:  [lowercaseAddress],
      simulateLoaded: true,
    });

    // Confirm precondition: list is now marked as loaded.
    const status = getSanctionsStatus();
    expect(status.isUnavailable).toBe(false);
    expect(status.addressCount).toBe(1);
    expect(status.lastSyncedAt).not.toBeNull();

    // Lowercase input must hit the Set.
    expect(isSanctioned(lowercaseAddress)).toBe(true);

    // Checksum-cased input for the same address must also hit.
    // This exercises isSanctioned()'s read-path .toLowerCase() normalisation:
    // '0x8576aCc5...' => '0x8576acc5...' => Set.has() => true.
    expect(isSanctioned(checksumAddress)).toBe(true);

    // An unrelated address must return false (not null — the list is loaded).
    expect(isSanctioned(unrelatedAddress)).toBe(false);
  });

  // --- Test 4: __resetForTests() guard in non-test env ---------------------

  test('__resetForTests() throws when NODE_ENV is not "test"', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => __resetForTests()).toThrow(
        '__resetForTests() must only be called in NODE_ENV=test'
      );
    } finally {
      // Always restore, even if the expect throws
      process.env.NODE_ENV = original;
    }
  });

});
