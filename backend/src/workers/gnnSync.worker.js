/**
 * workers/gnnSync.worker.js
 * ---------------------------------------------------------------------------
 * MODULE 3: Automated Tag Sync Worker
 * 
 * Periodically polls the local FastAPI Python microservice to retrieve OTC broker 
 * classifications. If a wallet is flagged as a broker by the PyTorch model, this 
 * worker writes the SUSPECTED_OTC_BROKER tag to Neo4j.
 */

import { runInTransaction } from '../services/neo4j.service.js';
import { logger } from '../lib/logger.js';
// Fetch is natively available in Node > 18

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';

/**
 * Syncs the OTC broker classification from the Python microservice to Neo4j.
 * 
 * @param {string} walletAddress - The address to query the GNN for
 */
export async function syncGnnClassification(walletAddress) {
  try {
    const response = await fetch(`${ML_SERVICE_URL}/predict/otc-risk`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-API-Key': process.env.INTERNAL_API_KEY
      },
      body: JSON.stringify({ address: walletAddress })
    });

    if (!response.ok) {
      throw new Error(`ML service responded with status ${response.status}`);
    }

    const result = await response.json();

    if (result.is_otc) {
      logger.warn(`[GNN Sync] SUSPECTED OTC BROKER detected by PyTorch model: ${walletAddress} (Confidence: ${result.confidence}, Model: ${result.modelType || 'heuristic_simulation'})`);
      await tagOtcBroker(walletAddress, result.confidence, result.modelType || 'heuristic_simulation');
      
      // Return the added risk score dimension (35 points as defined in mega-prompt)
      return 35;
    }
    
    return 0; // Not an OTC broker
  } catch (error) {
    logger.error(`[GNN Sync] Failed to sync classification for ${walletAddress}: ${error.message}`);
    return 0;
  }
}

async function tagOtcBroker(walletAddress, confidence, modelType) {
  const query = `
    MATCH (w:Wallet {address: $walletAddress})
    SET w.tags = coalesce(w.tags, []) + ['SUSPECTED_OTC_BROKER'],
        w.otcConfidence = $confidence,
        w.otcModelType = $modelType
  `;

  await runInTransaction('WRITE', async (tx) => {
    await tx.run(query, { walletAddress, confidence, modelType });
  });
}
