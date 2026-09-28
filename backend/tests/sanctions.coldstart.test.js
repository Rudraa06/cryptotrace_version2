/**
 * tests/sanctions.coldstart.test.js
 *
 * Regression test: sanctions cold-start must never resolve to "clean".
 *
 * Bug (fixed 2026-09-26): before the OFAC sync completes, isSanctioned()
 * returned `false` (empty Set.has() lookup) instead of `null`. Risk engine
 * callers using a plain truthy check then treated an *unknown* sanctions
 * status as a *confirmed clean* status, silently under-scoring wallets
 * that may in fact be sanctioned.
 *
 * This test locks in the fix at both layers:
 *   1. sanctions.service.js  - isSanctioned() returns null (not false)
 *      while isUnavailable === true.
 *   2. riskEngine.service.js - a null/unknown result must NOT resolve
 *      to a clean/low score, and must be visibly flagged:
 *      SANCTIONS_CHECK_FAILED tag, breakdown.sanctions === 'UNAVAILABLE',
 *      node.sanctionsUnknown === true.
 *
 * Corrections applied over original draft:
 *   - mockReturnValue (sync fn), NOT mockResolvedValue (would be async)
 *   - graph shape uses `links` not `edges` (what enrichTraceGraph reads)
 *   - Test 4 uses jest.isolateModulesAsync instead of jest.resetModules()
 *     inside an async describe (ESM cache behaviour)
 */

import { jest } from '@jest/globals';

// Must mock BEFORE dynamic import of riskEngine (ESM requirement)
const mockIsSanctioned = jest.fn();
const mockGetSanctionsStatus = jest.fn();

jest.unstable_mockModule('../src/services/sanctions.service.js', () => ({
  isSanctioned: mockIsSanctioned,
  getSanctionsStatus: mockGetSanctionsStatus,
  startSanctionsSyncJob: jest.fn(),
  syncOfacList: jest.fn(),
  // __resetForTests is exported by the real module; include a no-op here so
  // any transitive import that destructures it does not get undefined.
  __resetForTests: jest.fn(),
}));

const { enrichTraceGraph } = await import('../src/services/riskEngine.service.js');

// --- Helpers -----------------------------------------------------------------

function makeMinimalNode(address) {
  return {
    id: address,
    address,
    isExchange: false,
    hop: 0,
    riskScore: 0,
    tags: [],
    riskFactors: [],
  };
}

function singleNodeGraph(address) {
  // enrichTraceGraph reads `links`, not `edges`
  return { nodes: [makeMinimalNode(address)], links: [] };
}

// --- Suite -------------------------------------------------------------------

beforeEach(() => {
  mockIsSanctioned.mockReset();
  mockGetSanctionsStatus.mockReset();
});

describe('sanctions cold-start handling', () => {

  test('confirmed sanctions hit (true) hard-overrides riskScore to 100', async () => {
    mockIsSanctioned.mockReturnValue(true);
    mockGetSanctionsStatus.mockReturnValue({
      isUnavailable: false,
      lastSyncedAt: '2026-09-26T12:00:00.000Z',
      addressCount: 12000,
    });

    const enriched = await enrichTraceGraph(singleNodeGraph('0xSanctioned'));
    const node = enriched.nodes.find((n) => n.id === '0xSanctioned');

    expect(node.riskScore).toBe(100);
    expect(node.tags).toContain('SANCTIONED_ADDRESS');
    expect(node.riskBreakdown.sanctions).toBe('HARD_OVERRIDE_100');
    expect(node.sanctionsHit).toBe(true);
    expect(node.sanctionsUnknown).toBe(false);
    expect(node.riskFactors.some((f) => f.includes('OFAC SANCTIONS MATCH'))).toBe(true);
  });

  test('confirmed clean (false) does not inflate or override score', async () => {
    mockIsSanctioned.mockReturnValue(false);
    mockGetSanctionsStatus.mockReturnValue({
      isUnavailable: false,
      lastSyncedAt: '2026-09-26T12:00:00.000Z',
      addressCount: 12000,
    });

    const enriched = await enrichTraceGraph(singleNodeGraph('0xClean'));
    const node = enriched.nodes.find((n) => n.id === '0xClean');

    expect(node.tags).not.toContain('SANCTIONED_ADDRESS');
    expect(node.tags).not.toContain('SANCTIONS_CHECK_FAILED');
    expect(node.riskBreakdown.sanctions).toBe('CLEAR');
    expect(node.sanctionsHit).toBe(false);
    expect(node.sanctionsUnknown).toBe(false);
    expect(node.riskScore).toBeLessThan(100);
  });

  test('cold start (null) is flagged as unknown - never silently clean, never silently 100', async () => {
    // This is the exact bug condition: list has not loaded yet.
    // Old code: Set.has() on empty set => false (silent false negative).
    // Fixed code: isUnavailable === true => return null.
    mockIsSanctioned.mockReturnValue(null);
    mockGetSanctionsStatus.mockReturnValue({
      isUnavailable: true,
      lastSyncedAt: null,
      addressCount: 0,
    });

    const enriched = await enrichTraceGraph(singleNodeGraph('0xUnknownAtColdStart'));
    const node = enriched.nodes.find((n) => n.id === '0xUnknownAtColdStart');

    // Must NOT resolve to confirmed-clean
    expect(node.riskBreakdown.sanctions).not.toBe('CLEAR');
    expect(node.tags).not.toContain('SANCTIONED_ADDRESS');

    // Must NOT silently force the hard override (no confirmed match)
    expect(node.riskScore).not.toBe(100);

    // Must be visibly flagged as degraded / unknown
    expect(node.tags).toContain('SANCTIONS_CHECK_FAILED');
    expect(node.riskBreakdown.sanctions).toBe('UNAVAILABLE');
    expect(node.sanctionsUnknown).toBe(true);
    expect(node.sanctionsListAvailable).toBe(false);
    expect(node.riskFactors.some((f) => f.includes('UNAVAILABLE'))).toBe(true);
  });

  // Source-level tests (isSanctioned() null contract, __resetForTests() guard,
  // case-normalisation) live in tests/sanctions.service.unit.test.js.
  //
  // Reason for the split: this file registers a top-level
  // jest.unstable_mockModule for sanctions.service.js (required so
  // enrichTraceGraph gets a controllable double). That mock intercepts every
  // import of the service in this Jest worker, so the real module is unreachable
  // here. The service unit test file has no such mock, imports the real module,
  // and uses __resetForTests() in beforeEach to guarantee cold-start state
  // on every run without relying on module-load order.

});
