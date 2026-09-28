import { runInTransaction } from './src/services/neo4j.service.js';

runInTransaction('READ', tx => tx.run('MATCH (c:BtcCluster {clusterId: "1Ez69SnzzmePmZX3WpEzMKTrcBF2gpNQ55"})-[r:SENT_TO]->(other) RETURN other.clusterId, r LIMIT 5'))
  .then(r => {
    console.log(r.records.map(x => ({ target: x.get(0), rel: x.get(1).properties })));
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
