import { jest } from '@jest/globals';

// Setup Neo4j mocking
const mockRunInTransaction = jest.fn();
await jest.unstable_mockModule('../src/services/neo4j.service.js', () => ({
  runInTransaction: mockRunInTransaction,
  fromNeoInt: (val) => val,
  GraphDisabledError: class extends Error {}
}));

await jest.unstable_mockModule('../src/config/env.js', () => ({
  config: { graph: { enabled: true } }
}));

const { findBtcCashOutPaths, assertHopBound } = await import('../src/services/btcTrace.service.js');

describe('btcTrace.service.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid maxHops', () => {
    expect(() => assertHopBound(0)).toThrow(/maxHops must be an integer/);
    expect(() => assertHopBound(30)).toThrow(/maxHops must be an integer/);
    expect(assertHopBound(5)).toBe(5);
  });

  it('rejects invalid BTC address formats', async () => {
    await expect(findBtcCashOutPaths('0x123')).rejects.toThrow('Invalid BTC address');
  });

  it('returns WALLET_NOT_IN_GRAPH when address is unseen', async () => {
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { 
        run: jest.fn(async (cypher) => {
          if (cypher.includes('count(c) AS total')) return { records: [{ get: () => 1 }] };
          return { records: [] }; // No address found
        })
      };
      return cb(session);
    });

    const result = await findBtcCashOutPaths('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect(result.found).toBe(false);
    expect(result.reason).toBe('BTC_ADDRESS_NOT_IN_GRAPH');
  });

  it('returns NO_BTC_EXCHANGE_SEEDED when exchanges missing', async () => {
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { 
        run: jest.fn(async (cypher) => {
          if (cypher.includes('count(c) AS total')) return { records: [{ get: () => 0 }] };
          return { records: [{ get: () => '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }] };
        })
      };
      return cb(session);
    });

    const result = await findBtcCashOutPaths('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect(result.found).toBe(false);
    expect(result.reason).toBe('NO_BTC_EXCHANGE_SEEDED');
  });

  it('resolves topological shortestPath and extracts underlying UTXOs', async () => {
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { 
        run: jest.fn(async (cypher, params) => {
          if (cypher.includes('count(c) AS total')) return { records: [{ get: () => 1 }] };
          if (cypher.includes('RETURN a.address AS address')) return { records: [{ get: () => '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }] };
          
          if (cypher.includes('shortestPath')) {
            return {
              records: [
                {
                  get: (key) => {
                    if (key === 'clusters') return ['cluster_A', 'cluster_B', 'cluster_C'];
                    if (key === 'hops') return 2;
                    if (key === 'exchangeName') return 'Binance';
                    if (key === 'exchangeAddress') return 'cluster_C';
                  }
                }
              ]
            };
          }

          if (cypher.includes('LIMIT 1')) {
            // Mock the UTXO step extraction
            if (params.source === 'cluster_A') {
              return {
                records: [{
                  get: (key) => {
                    if (key === 'fromCluster') return 'cluster_A';
                    if (key === 'toCluster') return 'cluster_B';
                    if (key === 'fromMembers') return ['1TargetAddr'];
                    if (key === 'toMembers') return ['1Intermediary'];
                    if (key === 'hash') return 'tx1';
                    if (key === 'valueSats') return 500000000; // 5 BTC
                    if (key === 'blockTime') return 1700000000;
                    if (key === 'blockHeight') return 800000;
                  }
                }]
              };
            }
            if (params.source === 'cluster_B') {
              return {
                records: [{
                  get: (key) => {
                    if (key === 'fromCluster') return 'cluster_B';
                    if (key === 'toCluster') return 'cluster_C';
                    if (key === 'fromMembers') return ['1Intermediary'];
                    if (key === 'toMembers') return ['1BinanceAddr'];
                    if (key === 'hash') return 'tx2';
                    if (key === 'valueSats') return 200000000; // 2 BTC
                    if (key === 'blockTime') return 1700000100;
                    if (key === 'blockHeight') return 800001;
                  }
                }]
              };
            }
          }
          return { records: [] };
        })
      };
      return cb(session);
    });

    const result = await findBtcCashOutPaths('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect(result.found).toBe(true);
    expect(result.paths.length).toBe(1);
    
    const path = result.paths[0];
    expect(path.hops).toBe(2);
    expect(path.exchange.exchange).toBe('Binance');
    expect(path.steps.length).toBe(2);
    
    // Amounts should not be summed, bottleneck logic should work
    expect(path.amountIntoExchange).toBe(2); // 2 BTC final hop
    expect(path.bottleneckAmount).toBe(2); // Min(5, 2)
    
    // Temporal logic check
    expect(path.temporallyOrdered).toBe(true);
  });
});
