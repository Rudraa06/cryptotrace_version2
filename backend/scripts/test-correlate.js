import { createApp } from '../src/app.js';
import request from 'supertest';
import { inMemoryCrossCaseStore } from '../src/routes/complaints.routes.js';
import * as neo4jService from '../src/services/neo4j.service.js';
// Instead of jest, let's just monkey-patch neo4jService

// Instead of jest, let's just monkey-patch neo4jService
const originalRunInTransaction = neo4jService.runInTransaction;
neo4jService.runInTransaction = async (mode, callback) => {
  const fakeTx = {
    run: async (query, params) => {
      if (query.includes('shortestPath')) {
        return {
          records: [
            {
              get: (key) => {
                if (key === 'path') return { segments: [] }; // Mock empty path segments
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
};

async function run() {
  const app = createApp();

  // Test Wallets from fixtures (Group I: Cross-case correlation)
  const victim = '0xa8b93902315a6b010c262089408e0018a28db940'; // synthAddress('i-victim1')
  const suspect = '0xdb21b5ffdbf1345ab2f6ab326d97a61d152c5054'; // synthAddress('i-shared-intermediary')

  // Set API Key from config
  const { config } = await import('../src/config/env.js');
  const apiKey = config.apiKeys[0];

  const response = await request(app)
    .post('/api/trace/correlate')
    .set('x-api-key', apiKey)
    .send({ victimWallet: victim, suspectWallet: suspect, maxHops: 5 });

  console.log("=== /api/trace/correlate JSON Response ===");
  console.log(JSON.stringify(response.body, null, 2));

  // To show repeat-offender score, let's also run enrichTraceGraph from riskEngine
  const { enrichTraceGraph } = await import('../src/services/riskEngine.service.js');
  const dummyGraph = {
    nodes: [
      { id: suspect, isExchange: false, tags: [], crossCaseIds: ['CASE-A1', 'CASE-A2', 'CASE-A3'] }
    ],
    links: [] // No outbound links = final destination
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

  process.exit(0);
}

run();
