import { logger } from '../lib/logger.js';
import { runInTransaction, GraphDisabledError } from './neo4j.service.js';
import { config } from '../config/env.js';

const BTC_API_URL = process.env.BTC_INDEXER_URL || 'https://mempool.space/api';

/**
 * Validates a BTC address format loosely before hitting the indexer.
 */
function isValidBtcAddress(address) {
  // basic regex for legacy, p2sh, and bech32
  return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(address);
}

/**
 * Validates connection to the BTC indexer (Mempool API).
 * Used by /health endpoint.
 */
export async function checkBtcIndexerHealth() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const start = Date.now();
    // Hit a lightweight endpoint: block tip height
    const res = await fetch(`${BTC_API_URL}/blocks/tip/height`, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const height = await res.text();
    return { ok: true, latencyMs: Date.now() - start, blockHeight: Number(height) };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch one page of transactions for a BTC address.
 * 
 * "Wrong quietly" discipline: explicit error states for API down, rate limits, 
 * or malformed data, rather than silently returning an empty array.
 */
async function fetchAddressTxsPage(address, afterTxid = null) {
  let url = `${BTC_API_URL}/address/${address}/txs`;
  if (afterTxid) {
    url = `${BTC_API_URL}/address/${address}/txs/chain/${afterTxid}`;
  }

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    logger.error('BTC indexer network error', { address, error: err.message });
    return { error: 'INDEXER_DOWN', message: err.message };
  }

  if (response.status === 429) {
    return { error: 'RATE_LIMITED', message: 'Mempool API rate limit exceeded.' };
  }
  if (!response.ok) {
    const text = await response.text();
    return { error: 'INDEXER_ERROR', message: `HTTP ${response.status}: ${text}` };
  }

  try {
    const data = await response.json();
    if (!Array.isArray(data)) {
      return { error: 'MALFORMED_DATA', message: 'Expected array of transactions.' };
    }
    return { data };
  } catch (err) {
    return { error: 'MALFORMED_DATA', message: 'Invalid JSON from indexer.' };
  }
}

/**
 * Ingests a single transaction into Neo4j.
 * Creates BtcTransaction, BtcOutput, BtcAddress nodes and links them.
 */
async function ingestTransactionCypher(tx, session) {
  const txid = tx.txid;
  const blockHeight = tx.status?.block_height || 0;
  const blockTime = tx.status?.block_time || 0;

  // Prepare input records for UNWIND
  const inputs = [];
  for (const vin of tx.vin || []) {
    if (!vin.prevout || !vin.prevout.scriptpubkey_address) continue;
    inputs.push({
      inputAddress: vin.prevout.scriptpubkey_address,
      outputId: `${vin.txid}:${vin.vout}`,
      valueSats: vin.prevout.value
    });
  }

  // Prepare output records for UNWIND
  const outputs = [];
  const vouts = tx.vout || [];
  for (let i = 0; i < vouts.length; i++) {
    const vout = vouts[i];
    if (!vout.scriptpubkey_address) continue;
    outputs.push({
      outputAddress: vout.scriptpubkey_address,
      outputId: `${txid}:${i}`,
      valueSats: vout.value
    });
  }

  // Write everything for this transaction in one round-trip
  await session.run(
    `
    // 1. Write the transaction node
    MERGE (t:BtcTransaction {txid: $txid})
    SET t.blockHeight = $blockHeight, t.blockTime = $blockTime
    
    WITH t
    // 2. Process all inputs
    UNWIND $inputs AS inp
    MERGE (aIn:BtcAddress {address: inp.inputAddress})
    MERGE (oIn:BtcOutput {outputId: inp.outputId})
    ON CREATE SET oIn.valueSats = toInteger(inp.valueSats), oIn.address = inp.inputAddress, oIn.spent = true
    ON MATCH SET oIn.spent = true
    MERGE (aIn)-[:OWNS]->(oIn)
    MERGE (oIn)-[:SPENT_BY]->(t)
    
    WITH t
    // 3. Process all outputs
    UNWIND $outputs AS out
    MERGE (aOut:BtcAddress {address: out.outputAddress})
    MERGE (oOut:BtcOutput {outputId: out.outputId})
    ON CREATE SET oOut.valueSats = toInteger(out.valueSats), oOut.address = out.outputAddress, oOut.spent = false
    MERGE (aOut)-[:OWNS]->(oOut)
    MERGE (t)-[:HAS_OUTPUT]->(oOut)
    `,
    { txid, blockHeight, blockTime, inputs, outputs }
  );
}

/**
 * Fetch and ingest all transactions for a given BTC address.
 * Paginate until exhaustion or max pages.
 */
export async function ingestBtcAddress(address, maxPages = 5) {
  if (!isValidBtcAddress(address)) {
    return { ok: false, error: 'INVALID_ADDRESS', message: 'Not a valid BTC address.' };
  }

  let afterTxid = null;
  let txCount = 0;
  let pages = 0;

  try {
    while (pages < maxPages) {
      const result = await fetchAddressTxsPage(address, afterTxid);
      
      if (result.error) {
        // Return explicitly rather than ignoring the error, per UTXO Phase 1 instructions
        return { ok: false, error: result.error, message: result.message, ingested: txCount };
      }

      const txs = result.data;
      if (txs.length === 0) {
        break; // Reached end of history
      }

      // Ingest this page transactionally
      await runInTransaction('WRITE', async (session) => {
        for (const tx of txs) {
          if (!tx.status || !tx.status.confirmed) continue; // Skip unconfirmed txs to keep graph stable
          await ingestTransactionCypher(tx, session);
          txCount++;
        }
      });

      afterTxid = txs[txs.length - 1].txid;
      pages++;
      
      // If we got fewer than 50 txs, it's the last page (Mempool API page size is 25 or 50)
      if (txs.length < 25) {
        break;
      }
    }

    return { ok: true, ingested: txCount, pages };
  } catch (err) {
    if (err instanceof GraphDisabledError) {
      return { ok: false, error: 'GRAPH_DISABLED', message: 'Neo4j is disabled.' };
    }
    logger.error('BTC ingestion failed', { address, error: err.message });
    return { ok: false, error: 'INTERNAL_ERROR', message: err.message };
  }
}
