import { logger } from '../lib/logger.js';
import { runInTransaction, GraphDisabledError } from './neo4j.service.js';

/**
 * Phase 2: Common-Input-Ownership Clustering & CoinJoin Detection
 * 
 * Implements the heuristics defined in CRYPTOTRACE_PROJECT_CONTEXT.md.
 */

export async function runBtcClustering() {
  try {
    await runInTransaction('WRITE', async (session) => {
      // Step 1: Ensure all addresses have a default cluster (clusterId = address)
      await session.run(`
        MATCH (a:BtcAddress)
        WHERE NOT (a)-[:BELONGS_TO]->(:BtcCluster)
        MERGE (c:BtcCluster {clusterId: a.address})
        MERGE (a)-[:BELONGS_TO]->(c)
      `);

      // Step 2: Detect Probable CoinJoins
      // A transaction with >= 3 inputs and >= 3 equal-value outputs is flagged.
      await session.run(`
        MATCH (t:BtcTransaction)
        WHERE t.isCoinJoin IS NULL
        
        OPTIONAL MATCH (oIn:BtcOutput)-[:SPENT_BY]->(t)
        WITH t, count(oIn) AS inCount
        
        OPTIONAL MATCH (t)-[:HAS_OUTPUT]->(oOut:BtcOutput)
        WITH t, inCount, oOut.valueSats AS val, count(oOut) AS outCount
        
        WITH t, inCount, max(outCount) AS maxEqualOutputs
        SET t.isCoinJoin = (inCount >= 3 AND maxEqualOutputs >= 3)
      `);

      // Step 3: Cluster Common Inputs
      // Find all non-CoinJoin transactions that haven't been clustered
      const unclustered = await session.run(`
        MATCH (t:BtcTransaction {isCoinJoin: false})
        WHERE t.clustered IS NULL OR t.clustered = false
        MATCH (a:BtcAddress)-[:OWNS]->(o:BtcOutput)-[:SPENT_BY]->(t)
        WITH t, collect(DISTINCT a.address) AS addresses
        WHERE size(addresses) > 1
        RETURN t.txid AS txid, addresses
      `);

      for (const record of unclustered.records) {
        const txid = record.get('txid');
        const addresses = record.get('addresses');
        
        // Merge clusters for these addresses (deterministically choosing lowest clusterId)
        await session.run(`
          MATCH (a:BtcAddress) WHERE a.address IN $addresses
          MATCH (a)-[:BELONGS_TO]->(c:BtcCluster)
          WITH DISTINCT c
          ORDER BY c.clusterId ASC
          WITH collect(c) AS clusters
          WHERE size(clusters) > 1
          WITH clusters[0] AS survivor, clusters[1..] AS victims
          
          // Delete old SENT_TO edges for survivor and victims
          OPTIONAL MATCH (survivor)-[s1:SENT_TO]-() DELETE s1
          WITH survivor, victims
          UNWIND victims AS victim
          OPTIONAL MATCH (victim)-[s2:SENT_TO]-() DELETE s2
          WITH survivor, victims
          
          // Move BELONGS_TO edges to survivor
          UNWIND victims AS victim
          MATCH (addr:BtcAddress)-[r:BELONGS_TO]->(victim)
          MERGE (addr)-[:BELONGS_TO]->(survivor)
          DELETE r
          WITH survivor, victims
          
          // Delete victims
          UNWIND victims AS victim
          DELETE victim
          WITH survivor
          
          // Invalidate sentToMaterialized for all transactions touching the survivor cluster
          // so that SENT_TO edges are correctly recomputed in Step 4
          MATCH (survivor)<-[:BELONGS_TO]-(:BtcAddress)-[:OWNS]->(:BtcOutput)-[:SPENT_BY|HAS_OUTPUT]-(t2:BtcTransaction)
          SET t2.sentToMaterialized = false
        `, { addresses });
        
        // Mark tx as clustered
        await session.run(`MATCH (t:BtcTransaction {txid: $txid}) SET t.clustered = true`, { txid });
      }

      // Mark single-input transactions as clustered too
      await session.run(`
        MATCH (t:BtcTransaction {isCoinJoin: false})
        WHERE t.clustered IS NULL OR t.clustered = false
        SET t.clustered = true
      `);

      // Step 4: Materialize SENT_TO edges between clusters
      // This abstracts the UTXO flow into direct cluster-to-cluster edges for fast shortestPath tracing
      await session.run(`
        MATCH (t:BtcTransaction)
        WHERE t.sentToMaterialized IS NULL OR t.sentToMaterialized = false
        
        // Mark as materialized first to avoid skipping txs with no valid flow
        SET t.sentToMaterialized = true
        WITH t
        
        MATCH (sourceAddr:BtcAddress)-[:OWNS]->(:BtcOutput)-[:SPENT_BY]->(t)-[:HAS_OUTPUT]->(:BtcOutput)<-[:OWNS]-(targetAddr:BtcAddress)
        MATCH (sourceAddr)-[:BELONGS_TO]->(source:BtcCluster)
        MATCH (targetAddr)-[:BELONGS_TO]->(target:BtcCluster)
        WHERE source <> target
        
        MERGE (source)-[:SENT_TO]->(target)
      `);
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof GraphDisabledError) {
      return { ok: false, error: 'GRAPH_DISABLED', message: 'Neo4j is disabled.' };
    }
    logger.error('BTC clustering failed', { error: err.message });
    return { ok: false, error: 'INTERNAL_ERROR', message: err.message };
  }
}
