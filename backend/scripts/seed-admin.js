import bcrypt from 'bcrypt';
import { runInTransaction, GraphDisabledError } from '../src/services/neo4j.service.js';
import { logger } from '../src/lib/logger.js';
import crypto from 'crypto';

async function seedAdmin() {
  logger.info('Seeding initial SUPERVISOR account...');
  
  const email = process.env.ADMIN_EMAIL || 'admin@cybercell.gov.in';
  const rawPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64');
  const name = process.env.ADMIN_NAME || 'System Administrator';
  const department = process.env.ADMIN_DEPT || 'Cyber Cell HQ';

  try {
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    const investigatorId = crypto.randomUUID();

    await runInTransaction('WRITE', async (tx) => {
      await tx.run(`
        MERGE (i:Investigator {email: $email})
        ON CREATE SET 
          i.id = $id,
          i.passwordHash = $passwordHash,
          i.name = $name,
          i.role = 'SUPERVISOR',
          i.department = $department,
          i.isActive = true,
          i.createdAt = timestamp()
        ON MATCH SET
          i.passwordHash = $passwordHash,
          i.role = 'SUPERVISOR',
          i.isActive = true
      `, {
        email: email.toLowerCase(),
        id: investigatorId,
        passwordHash,
        name,
        department
      });
    });

    logger.info(`SUPERVISOR account seeded successfully.`);
    logger.info(`Email: ${email}`);
    logger.info(`Password: ${rawPassword}`);
    logger.info(`WARNING: If you used the default password, change it immediately in production.`);

  } catch (error) {
    if (error instanceof GraphDisabledError) {
      logger.error('Neo4j is disabled. Cannot seed investigator accounts.');
    } else {
      logger.error('Failed to seed SUPERVISOR account', { error: error.message });
    }
  } finally {
    process.exit(0);
  }
}

seedAdmin();
