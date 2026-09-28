import { jest } from '@jest/globals';

const mockRunInTransaction = jest.fn(async (mode, cb) => {
  const session = { run: jest.fn() };
  await cb(session);
});

jest.unstable_mockModule('../src/services/neo4j.service.js', () => ({
  runInTransaction: mockRunInTransaction,
  GraphDisabledError: class extends Error {}
}));

// Dynamic import AFTER mock is registered (ESM requirement)
const { ingestBtcAddress } = await import('../src/services/btcIngestion.service.js');

describe('btcIngestion.service.js', () => {
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('fails gracefully when indexer is down', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    
    const result = await ingestBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('INDEXER_DOWN');
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('fails gracefully on rate limit (429)', async () => {
    global.fetch.mockResolvedValue({ status: 429 });
    
    const result = await ingestBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('RATE_LIMITED');
  });

  it('fails gracefully on malformed json', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); }
    });
    
    const result = await ingestBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('MALFORMED_DATA');
  });

  it('rejects invalid BTC address formats', async () => {
    const result = await ingestBtcAddress('0xinvalidethaddress');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('INVALID_ADDRESS');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('ingests a single transaction correctly', async () => {
    // Mock API response with one confirmed tx
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        {
          txid: 'abcd123',
          status: { confirmed: true, block_height: 100, block_time: 1000 },
          vin: [
            { txid: 'oldtx', vout: 0, prevout: { scriptpubkey_address: '1Sender', value: 100000 } }
          ],
          vout: [
            { scriptpubkey_address: '1Receiver', value: 50000 },
            { scriptpubkey_address: '1Change', value: 49000 }
          ]
        }
      ])
    });

    let neo4jSessionMock;
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      neo4jSessionMock = { run: jest.fn() };
      await cb(neo4jSessionMock);
    });

    const result = await ingestBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    
    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(1);
    
    // Check that session.run was called to write the tx, inputs, and outputs (now batched)
    expect(neo4jSessionMock.run).toHaveBeenCalledTimes(1); 
    
    // Verify first call is BtcTransaction
    const cypher = neo4jSessionMock.run.mock.calls[0][0];
    const params = neo4jSessionMock.run.mock.calls[0][1];
    expect(cypher).toContain('MERGE (t:BtcTransaction');
    expect(cypher).toContain('UNWIND $inputs AS inp');
    expect(cypher).toContain('UNWIND $outputs AS out');
    
    expect(params.txid).toBe('abcd123');
    expect(params.inputs.length).toBe(1);
    expect(params.outputs.length).toBe(2);
  });

  it('paginates correctly using /txs/chain/:last_txid', async () => {
    // Page 1 returns 50 txs
    const page1 = Array(50).fill(null).map((_, i) => ({
      txid: `tx${i}`,
      status: { confirmed: true, block_height: 100 },
      vin: [], vout: []
    }));
    // Page 2 returns 15 txs
    const page2 = Array(15).fill(null).map((_, i) => ({
      txid: `tx${i+50}`,
      status: { confirmed: true, block_height: 101 },
      vin: [], vout: []
    }));

    global.fetch.mockImplementation(async (url) => {
      if (url.includes('/txs/chain/tx49')) {
        return { ok: true, status: 200, json: async () => page2 };
      }
      return { ok: true, status: 200, json: async () => page1 };
    });

    let runCount = 0;
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { run: jest.fn(() => runCount++) };
      await cb(session);
    });

    const result = await ingestBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    
    expect(result.ok).toBe(true);
    expect(result.pages).toBe(2);
    expect(result.ingested).toBe(65);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    
    // Check that the second fetch correctly used the chain endpoint
    expect(global.fetch.mock.calls[1][0]).toContain('/txs/chain/tx49');
  });

  it('handles the change-address case (same address as input and output)', async () => {
    const validAddress = '1SameAddress1111111111111111111111';
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        {
          txid: 'change_tx',
          status: { confirmed: true },
          vin: [{ txid: 'old', vout: 0, prevout: { scriptpubkey_address: validAddress, value: 1000 } }],
          vout: [
            { scriptpubkey_address: '1Receiver1111111111111111111111111', value: 800 },
            { scriptpubkey_address: validAddress, value: 200 } // Change back to same address
          ]
        }
      ])
    });

    let capturedParams;
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { 
        run: jest.fn((cypher, params) => { capturedParams = params; }) 
      };
      await cb(session);
    });

    const result = await ingestBtcAddress(validAddress);
    expect(result.ok).toBe(true);
    
    // We verify the data passed to UNWIND
    expect(capturedParams.inputs[0].inputAddress).toBe(validAddress);
    expect(capturedParams.outputs[1].outputAddress).toBe(validAddress);
    // Because the Cypher uses MERGE (a:BtcAddress {address: ...}), 
    // Neo4j inherently resolves both the input and output to the exact same node.
  });

  it('handles re-ingestion idempotently (returns ok on duplicate calls)', async () => {
    const validAddress = '1Addr11111111111111111111111111111';
    
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        {
          txid: 'tx_reingest',
          status: { confirmed: true },
          vin: [{ txid: 'old', vout: 0, prevout: { scriptpubkey_address: validAddress, value: 1000 } }],
          vout: [{ scriptpubkey_address: '1Addr21111111111111111111111111111', value: 1000 }]
        }
      ])
    });

    let runCount = 0;
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { run: jest.fn(() => runCount++) };
      await cb(session);
    });

    // Call it twice with the same mock response
    const result1 = await ingestBtcAddress(validAddress);
    const result2 = await ingestBtcAddress(validAddress);
    
    expect(result1.ok).toBe(true);
    expect(result1.ingested).toBe(1);
    
    expect(result2.ok).toBe(true);
    expect(result2.ingested).toBe(1);
    
    // Proves it didn't crash and processed the txs both times
    expect(runCount).toBe(2);
  });

  it('retains spent=true (testing Cypher string asymmetry directly)', async () => {
    // We cannot test true Neo4j DB semantics (Option A) until Neo4j is available in CI.
    // Instead, we verify the actual Cypher string executes exactly what we designed
    // (Option B) - specifically the absence of an ON MATCH clause for outputs.
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        {
          txid: 'tx_dummy',
          status: { confirmed: true },
          vin: [{ txid: 'old', vout: 0, prevout: { scriptpubkey_address: '1Target111111111111111111111111111', value: 500 } }],
          vout: [{ scriptpubkey_address: '1Target111111111111111111111111111', value: 500 }]
        }
      ])
    });

    let capturedCypher = '';
    mockRunInTransaction.mockImplementation(async (mode, cb) => {
      const session = { 
        run: jest.fn(async (cypher, params) => {
          capturedCypher = cypher;
        }) 
      };
      await cb(session);
    });

    const result = await ingestBtcAddress('1Target111111111111111111111111111');
    expect(result.ok).toBe(true);

    // Split the Cypher string by UNWIND blocks
    const parts = capturedCypher.split('UNWIND $outputs AS out');
    expect(parts.length).toBe(2);
    
    const inputsBlock = parts[0];
    const outputsBlock = parts[1];

    // Assert inputs block sets spent=true on match
    expect(inputsBlock).toContain('ON MATCH SET oIn.spent = true');
    
    // Assert outputs block NEVER resets spent=false on match
    expect(outputsBlock).not.toContain('ON MATCH');
  });
});
