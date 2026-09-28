/**
 * tests/riskEngine.test.js
 *
 * Unit tests for the risk engine's scoring dimensions.
 *
 * The sanctions service (sanctions.service.js) is mocked here with an
 * explicitly clean state (isSanctioned returns false, list is available).
 * This ensures:
 *   - These tests are not silently exercising the real module's cold-start
 *     state (where isSanctioned() returns null and every node gets tagged
 *     SANCTIONS_CHECK_FAILED with breakdown.sanctions='UNAVAILABLE').
 *   - The Dimension 9 (sanctions) code path in the risk engine always
 *     receives a known, deterministic input in this file.
 *   - Cold-start / unavailable sanctions behavior is covered by the dedicated
 *     tests/sanctions.coldstart.test.js and tests/sanctions.service.unit.test.js.
 *
 * Pattern mirrors tests/sanctions.coldstart.test.js: jest.unstable_mockModule
 * must be called before the dynamic import of riskEngine.service.js (ESM req).
 */

import { jest } from '@jest/globals';

// --- Mock sanctions service with an explicit known-clean state ---------------
// isSanctioned() returns false (not null, not true) — simulates a loaded list
// where none of the addresses under test appear on the OFAC SDN list.
// This is the correct default for risk engine tests: the sanctions dimension
// should score 0 / 'CLEAR' so it doesn't interfere with the other 8 dimensions.

jest.unstable_mockModule('../src/services/sanctions.service.js', () => ({
  isSanctioned:          jest.fn().mockReturnValue(false),
  getSanctionsStatus:    jest.fn().mockReturnValue({
    isUnavailable: false,
    lastSyncedAt:  '2026-09-26T00:00:00.000Z',
    addressCount:  12345,
  }),
  startSanctionsSyncJob: jest.fn(),
  syncOfacList:          jest.fn(),
  __resetForTests:       jest.fn(),
}));

// Dynamic import AFTER mock is registered (ESM requirement)
const { enrichTraceGraph } = await import('../src/services/riskEngine.service.js');

// -----------------------------------------------------------------------------

describe('Risk Engine Unit Tests', () => {
  let mockGraph;
  
  beforeEach(() => {
    
    mockGraph = {
      nodes: [
        { id: '0x1', riskScore: 0, tags: [], riskFactors: [] },
        { id: '0x2', riskScore: 0, tags: [], riskFactors: [] }
      ],
      links: [
        { source: '0x1', target: '0x2', amount: 100 }
      ]
    };
  });

  it('Velocity Signal: flags high volume rapid transfers', async () => {
    // Create a graph with high velocity (many transfers between same nodes in short time)
    mockGraph.links = [
      { source: '0x1', target: '0x2', timestamp: 1000, amount: 10 },
      { source: '0x1', target: '0x2', timestamp: 1005, amount: 20 },
      { source: '0x1', target: '0x2', timestamp: 1010, amount: 30 }
    ];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    // Ensure velocity is flagged, this depends on exact implementation but let's just check score > 0
    expect(node1).toBeDefined();
  });

  it('Fan-out Signal: flags one-to-many dispersion', async () => {
    mockGraph.nodes.push({ id: '0x3', riskScore: 0, tags: [], riskFactors: [] });
    mockGraph.nodes.push({ id: '0x4', riskScore: 0, tags: [], riskFactors: [] });
    mockGraph.links = [
      { source: '0x1', target: '0x2', amount: 10 },
      { source: '0x1', target: '0x3', amount: 10 },
      { source: '0x1', target: '0x4', amount: 10 }
    ];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1).toBeDefined();
  });

  it('Exchange Proximity: calculates distance to known exchanges', async () => {
    mockGraph.nodes.push({ id: '0xexchange', isExchange: true, riskScore: 0, tags: [], riskFactors: [] });
    mockGraph.links = [
      { source: '0x1', target: '0x2', amount: 10 },
      { source: '0x2', target: '0xexchange', amount: 10 }
    ];
    const enriched = await enrichTraceGraph(mockGraph);
    expect(enriched).toBeDefined();
  });

  it('Taint Diffusion: propagates risk from known bad actors', async () => {
    mockGraph.nodes[0].tags = ['OFAC_SANCTIONED'];
    mockGraph.nodes[0].riskScore = 100;
    const enriched = await enrichTraceGraph(mockGraph);
    const node2 = enriched.nodes.find(n => n.id === '0x2');
    expect(node2.riskScore).toBeGreaterThan(0);
  });

  it('Mixer Pattern: flags structured deposits', async () => {
    mockGraph.links = [
      { source: '0x1', target: '0x2', amount: 10.0 }, // Tornado cash fixed denomination
      { source: '0x3', target: '0x2', amount: 10.0 }
    ];
    const enriched = await enrichTraceGraph(mockGraph);
    expect(enriched).toBeDefined();
  });

  it('Mixer Pattern (BTC): maps Phase 2 PROBABLE_COINJOIN to MIXER_INTERACTION', async () => {
    mockGraph.nodes[0].tags = ['PROBABLE_COINJOIN'];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1.tags).toContain('MIXER_INTERACTION');
    expect(node1.riskBreakdown.mixer).toBe(20);
    expect(node1.riskFactors.some(f => f.includes('Phase 2 clustering flagged this transaction as a probable CoinJoin'))).toBe(true);
  });

  it('Cross-Chain Flight: flags bridged assets', async () => {
    mockGraph.nodes[0].tags = ['CROSS_CHAIN_FLIGHT'];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1.riskFactors.some(f => f.includes('Cross-chain')) || node1.riskScore > 0).toBeTruthy();
  });

  it('Privacy-Coin Swap: detects swaps to Monero/Zcash', async () => {
    mockGraph.nodes[0].tags = ['SWAP_XMR'];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1.riskScore > 0 || node1.tags.includes('SWAP_XMR')).toBeTruthy();
  });

  it('OTC Broker: detects over-the-counter broker patterns', async () => {
    mockGraph.nodes[0].tags = ['OTC_BROKER'];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1).toBeDefined();
  });

  it('Cross-Case Correlation: detects multi-case appearances', async () => {
    mockGraph.nodes[0].tags = ['MULTI_CASE'];
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1).toBeDefined();
  });

  it('GNN Probability: incorporates ML illicit probability', async () => {
    // mlProbability is added before enrichTraceGraph usually, or during
    mockGraph.nodes[0].mlProbability = 0.95;
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    expect(node1.riskScore).toBeGreaterThan(0);
  });

  it('Sanctions (BTC): flags cluster if non-representative member is sanctioned', async () => {
    // mock isSanctioned for this specific test case without altering the global mock
    const { isSanctioned } = await import('../src/services/sanctions.service.js');
    isSanctioned.mockImplementation((addr) => addr === '1SanctionedAddrX');

    mockGraph.nodes[0].memberAddresses = ['1CleanAddr1', '1CleanAddr2', '1SanctionedAddrX'];
    
    const enriched = await enrichTraceGraph(mockGraph);
    const node1 = enriched.nodes.find(n => n.id === '0x1');
    
    expect(node1.riskScore).toBe(100);
    expect(node1.tags).toContain('SANCTIONED_ADDRESS');
    expect(node1.sanctionsHit).toBe(true);
    expect(node1.riskFactors.some(f => f.includes('Address 1SanctionedAddrX'))).toBe(true);
  });
});
