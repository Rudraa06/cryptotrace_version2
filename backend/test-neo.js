import { driver, auth } from 'neo4j-driver';
const d = driver('neo4j://localhost:7687', auth.basic('neo4j', '12345678'));
const session = d.session();
async function run() {
  const r = await session.run(`
    MATCH (a:BtcAddress {address: "bc1q2qvu46nu6808qrm8ymmr5xjw0x9ssvlmrlvkfq"})-[:BELONGS_TO]->(c:BtcCluster)-[:SENT_TO]->(target:BtcCluster)
    RETURN target.clusterId
  `);
  console.log(r.records.map(rec => rec.get(0)));
  const r2 = await session.run(`MATCH (a:BtcAddress {address: "bc1q2qvu46nu6808qrm8ymmr5xjw0x9ssvlmrlvkfq"}) RETURN a`);
  console.log("Address node:", r2.records.length > 0);
  const r3 = await session.run(`MATCH (c:BtcCluster {clusterId: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s"}) RETURN c`);
  console.log("Exchange cluster:", r3.records.length > 0 ? r3.records[0].get(0).properties : false);
  await session.close();
  await d.close();
}
run();
