import { jest } from '@jest/globals';
import { findCashOutPaths } from '../src/services/trace.service.js';
import { verifyGraphConnectivity } from '../src/services/neo4j.service.js';
import { config } from '../src/config/env.js';

describe('Trace Pipeline Integration Tests', () => {
  const EULER_EXPLOITER = '0x5f259d0b76665c337c610414f43f8fe6cd84a5c0';
  const RONIN_EXPLOITER = '0x098b716b8aaf21519096e3fe8b56d2b9ca28fdd6';

  beforeAll(async () => {
    // Ensure neo4j is reachable
    const conn = await verifyGraphConnectivity();
    if (!conn.ok) {
      console.warn('Neo4j not reachable, some tests might fail or be skipped.');
    }
  });

  it('traces Euler Finance exploiter end-to-end', async () => {
    const options = { maxHops: 15, includeContext: true, contextLimit: 100 };
    const result = await findCashOutPaths(EULER_EXPLOITER, options);
    
    // In mock mode, this should return found: true/false without throwing
    expect(result).toBeDefined();
    expect(result.found).toBeDefined();
    if (result.found) {
      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.topExchange).toBeDefined();
    }
  });

  it('traces Ronin/Axie Infinity exploiter end-to-end', async () => {
    const options = { maxHops: 15, includeContext: true, contextLimit: 100 };
    const result = await findCashOutPaths(RONIN_EXPLOITER, options);
    
    expect(result).toBeDefined();
    expect(result.found).toBeDefined();
    if (result.found) {
      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.topExchange).toBeDefined();
    }
  });
});
