import { runInTransaction } from './src/services/neo4j.service.js';
async function test() {
  await runInTransaction('READ', async (tx) => {
    const res = await tx.run('MATCH (i:Investigator {email: "admin@cybercell.gov.in"}) RETURN i.isActive AS isActive, i.mfaEnabled AS mfaEnabled');
    console.log(res.records[0]?.toObject());
  });
  process.exit(0);
}
test();
