import { runInTransaction } from './src/services/neo4j.service.js';

async function check() {
  const result = await runInTransaction('READ', async (tx) => {
    return tx.run(`MATCH (i:Investigator {email: "admin@cybercell.gov.in"}) RETURN i.role`);
  });
  const role = result.records[0].get(0);
  console.log(`Role: [${role}]`);
  console.log(`Length: ${role.length}`);
  console.log(`Type: ${typeof role}`);
  process.exit(0);
}
check();
