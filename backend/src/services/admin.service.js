import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { runInTransaction } from './neo4j.service.js';
import { logger } from '../lib/logger.js';

export async function ensureGlobalAdmin() {
  const email = process.env.GLOBAL_ADMIN_EMAIL || 'admin@cybercell.gov.in';
  const rawPassword = process.env.GLOBAL_ADMIN_PASSWORD || 'CryptoTrace123!';
  const name = 'Global Administrator';
  const department = 'HQ';

  try {
    const passwordHash = await bcrypt.hash(rawPassword, 10);
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
          i.mfaEnabled = false,
          i.createdAt = timestamp()
        ON MATCH SET
          i.passwordHash = $passwordHash,
          i.role = 'SUPERVISOR',
          i.isActive = true,
          i.mfaEnabled = false
      `, {
        email: email.toLowerCase(),
        id: investigatorId,
        passwordHash,
        name,
        department
      });
    });
    logger.info(`Global Admin secured [Email: ${email}]`);
  } catch (error) {
    logger.error('Failed to ensure global admin', { error: error.message });
  }
}

