import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { runInTransaction } from './src/services/neo4j.service.js';

(async () => {
  const pwd = await bcrypt.hash('testpass123', 10);
  await runInTransaction('WRITE', async tx => {
    await tx.run('CREATE (i:Investigator {id: $id, name: "Test User", email: "test@cybercell.gov.in", role: "INVESTIGATOR", isActive: true, passwordHash: $pwd})', { id: crypto.randomUUID(), pwd });
    console.log('Test user seeded.');
    process.exit(0);
  });
})();
