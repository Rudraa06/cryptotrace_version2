import { runInTransaction, closeDriver } from '../src/services/neo4j.service.js';

async function injectMockCrossChain() {
  console.log('Injecting CROSS_CHAIN_FLIGHT tag into Neo4j for demo...');

  const query = `
    MATCH (w:Wallet)
    WHERE toLower(w.address) = toLower('0x318973a740a406c3c319858d598d238a611872a1')
    SET w.tags = coalesce(w.tags, []) + ['CROSS_CHAIN_FLIGHT'],
        w.riskScore = 80
    RETURN w.address as addr, w.tags as tags
  `;

  await runInTransaction('WRITE', async (tx) => {
    const result = await tx.run(query);
    if (result.records.length > 0) {
      console.log(`Successfully tagged ${result.records[0].get('addr')} with tags: ${result.records[0].get('tags')}`);
    } else {
      console.log('Wallet not found in neo4j!');
    }
  });

  await closeDriver();
  console.log('Done! You can now run NCRP-TEST-001 on the frontend to see the Cross-Chain alert.');
}

injectMockCrossChain().catch(console.error);
