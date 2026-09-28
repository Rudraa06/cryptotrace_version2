import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { inMemoryCrossCaseStore } from '../src/routes/complaints.routes.js';
import { enrichTraceGraph } from '../src/services/riskEngine.service.js';

// Mock Neo4j
jest.unstable_mockModule('../src/services/neo4j.service.js', () => {
  return {
    verifyGraphConnectivity: jest.fn().mockResolvedValue({ ok: true }),
    runInTransaction: jest.fn().mockImplementation(async (mode, callback) => {
      const fakeTx = {
        run: async (query, params) => {
          if (query.includes('shortestPath')) {
            return {
              records: [
                {
                  get: (key) => {
                    if (key === 'path') return { segments: [] }; 
                    if (key === 'hops') return { low: 3, high: 0 }; // 3 hops
                  }
                }
              ]
            };
          }
          if (query.includes('suspect.caseIds AS caseIds')) {
            return {
              records: [
                {
                  get: (key) => {
                    if (key === 'caseIds') return ['CASE-A1', 'CASE-A2', 'CASE-A3'];
                    if (key === 'complaintIds') return ['C-1', 'C-2', 'C-3'];
                  }
                }
              ]
            };
          }
          return { records: [] };
        }
      };
      return callback(fakeTx);
    }),
    fromNeoInt: (obj) => obj ? obj.low : null,
    toNeoInt: (num) => ({ low: num, high: 0 }),
    GraphDisabledError: class extends Error {}
  };
});

describe('Phase 2B Correlation Test', () => {
  it('runs correlation and calculates repeat offender score', async () => {
    // Dynamic import to allow mock to take effect
    const { createApp } = await import('../src/app.js');
    const { config } = await import('../src/config/env.js');
    const apiKey = config.internalApiKey || 'mock-key';
    
    const app = createApp();
    const victim = '0xa8b93902315a6b010c262089408e0018a28db940'; 
    const suspect = '0xdb21b5ffdbf1345ab2f6ab326d97a61d152c5054'; 

    const response = await request(app)
      .post('/api/trace/correlate')
      .set('x-api-key', apiKey)
      .send({ victimWallet: victim, suspectWallet: suspect, maxHops: 5 });

    console.log("=== /api/trace/correlate JSON Response ===");
    console.log(JSON.stringify(response.body, null, 2));

    const dummyGraph = {
      nodes: [
        { id: suspect, isExchange: false, tags: [], crossCaseIds: ['CASE-A1', 'CASE-A2', 'CASE-A3'] }
      ],
      links: [] 
    };
    
    const enriched = await enrichTraceGraph(dummyGraph);
    console.log("\n=== Repeat Offender Score on Suspect Node ===");
    const node = enriched.nodes[0];
    console.log(JSON.stringify({
      address: node.id,
      crossCaseScore: node.riskBreakdown.crossCase,
      repeatOffenderScore: node.riskBreakdown.repeatOffender,
      riskFactors: node.riskFactors,
      tags: node.tags
    }, null, 2));
    
    expect(response.status).toBe(200);
  });
});
