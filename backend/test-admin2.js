import { runInTransaction } from './src/services/neo4j.service.js';
async function test() {
  await runInTransaction('READ', async (tx) => {
    const res = await tx.run('MATCH (i:Investigator {email: "admin@cybercell.gov.in"}) RETURN count(i) AS c');
    console.log("Count:", res.records[0].get('c').toString());
  });
  process.exit(0);
}
test();
