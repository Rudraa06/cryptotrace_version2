import { jest } from '@jest/globals';

const mockRunInTransaction = jest.fn(async (mode, cb) => {
  const session = { 
    run: jest.fn(async (cypher, params) => {
      // Mock the unclustered transactions query to return a dummy record
      if (cypher.includes('MATCH (t:BtcTransaction {isCoinJoin: false})') && cypher.includes('RETURN t.txid AS txid, addresses')) {
        return {
          records: [
            {
              get: (key) => {
                if (key === 'txid') return 'dummy_txid';
                if (key === 'addresses') return ['1AddrA', '1AddrB'];
              }
            }
          ]
        };
      }
      return { records: [] };
    })
  };
  await cb(session);
});

jest.unstable_mockModule('../src/services/neo4j.service.js', () => ({
  runInTransaction: mockRunInTransaction,
  GraphDisabledError: class extends Error {}
}));

const { runBtcClustering } = await import('../src/services/btcClustering.service.js');

describe('btcClustering.service.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs all 4 phases of clustering successfully', async () => {
    let capturedCyphers = [];
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { 
        run: jest.fn(async (cypher, params) => {
          capturedCyphers.push(cypher);
          if (cypher.includes('RETURN t.txid AS txid, addresses')) {
            return {
              records: [
                {
                  get: (key) => {
                    if (key === 'txid') return 'tx123';
                    if (key === 'addresses') return ['1AddrA', '1AddrB'];
                  }
                }
              ]
            };
          }
          return { records: [] };
        })
      };
      await cb(session);
    });

    const result = await runBtcClustering();
    expect(result.ok).toBe(true);

    // Verify Step 1: Default clusters
    expect(capturedCyphers.some(c => c.includes('MERGE (c:BtcCluster {clusterId: a.address})'))).toBe(true);
    
    // Verify Step 2: CoinJoin detection
    expect(capturedCyphers.some(c => c.includes('SET t.isCoinJoin = (inCount >= 3 AND maxEqualOutputs >= 3)'))).toBe(true);
    
    // Verify Step 3: Cluster merging for tx123
    expect(capturedCyphers.some(c => c.includes('WITH clusters[0] AS survivor, clusters[1..] AS victims'))).toBe(true);
    expect(capturedCyphers.some(c => c.includes('SET t2.sentToMaterialized = false'))).toBe(true); // invalidation
    expect(capturedCyphers.some(c => c.includes('SET t.clustered = true'))).toBe(true);
    
    // Verify Step 4: SENT_TO materialization
    expect(capturedCyphers.some(c => c.includes('MERGE (source)-[:SENT_TO]->(target)'))).toBe(true);
  });

  it('fails gracefully if Neo4j is disabled', async () => {
    mockRunInTransaction.mockRejectedValueOnce(new (await import('../src/services/neo4j.service.js')).GraphDisabledError());
    
    const result = await runBtcClustering();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('GRAPH_DISABLED');
  });

  it('fails gracefully on unexpected error', async () => {
    mockRunInTransaction.mockRejectedValueOnce(new Error('Syntax Error'));
    
    const result = await runBtcClustering();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('INTERNAL_ERROR');
  });
});
