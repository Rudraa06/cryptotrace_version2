import { Router } from 'express';
import crypto from 'crypto';
import { runInTransaction } from '../services/neo4j.service.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireRole } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { sendActivationEmail } from '../services/email.service.js';

export const investigatorsRouter = Router();

// All routes here require SUPERVISOR role
investigatorsRouter.use(requireRole(['SUPERVISOR']));

/**
 * GET /api/investigators
 * List all investigator accounts.
 */
investigatorsRouter.get('/', asyncRoute(async (req, res) => {
  let investigators = [];
  await runInTransaction('READ', async (tx) => {
    const result = await tx.run(
      `MATCH (i:Investigator) 
       RETURN i.id AS id, i.name AS name, i.email AS email, i.role AS role, i.department AS department, i.isActive AS isActive
       ORDER BY i.name ASC`
    );
    investigators = result.records.map(record => ({
      id: record.get('id'),
      name: record.get('name'),
      email: record.get('email'),
      role: record.get('role'),
      department: record.get('department'),
      isActive: record.get('isActive')
    }));
  });

  res.json({ ok: true, investigators });
}));

/**
 * POST /api/investigators
 * Create a new investigator and generate an activation token.
 */
investigatorsRouter.post('/', asyncRoute(async (req, res) => {
  const { name, email, role, department } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ ok: false, error: 'Name, email, and role are required.' });
  }

  // 1. Generate an activation token
  const activationToken = crypto.randomBytes(32).toString('hex');
  const tokenExpiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
  const id = crypto.randomUUID();

  let created = false;
  await runInTransaction('WRITE', async (tx) => {
    // Check if email already exists
    const check = await tx.run(`MATCH (i:Investigator {email: $email}) RETURN i`, { email: email.toLowerCase() });
    if (check.records.length > 0) {
      throw new Error('Email already in use.');
    }

    await tx.run(
      `CREATE (i:Investigator {
        id: $id,
        name: $name,
        email: $email,
        role: $role,
        department: $department,
        isActive: true,
        passwordHash: '*PENDING_ACTIVATION*',
        activationToken: $activationToken,
        activationExpiry: $tokenExpiry,
        createdAt: datetime()
      })`,
      {
        id,
        name,
        email: email.toLowerCase(),
        role,
        department: department || 'General',
        activationToken,
        tokenExpiry
      }
    );
    created = true;
  });

  if (created) {
    logger.info('New investigator created pending activation', { id, email, createdBy: req.investigator.id });
    
    // Send email with the token (will fallback to console log if API key missing)
    try {
      await sendActivationEmail(email, activationToken, name);
    } catch (err) {
      logger.error('Failed to send activation email, but account was created.', { error: err.message });
      // We still return success since the account exists in the DB
    }

    res.json({ ok: true, message: 'Investigator created successfully. Activation email sent.' });
  }
}));

/**
 * PATCH /api/investigators/:id
 * Toggle isActive status for instant revocation.
 */
investigatorsRouter.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  if (id === req.investigator.id) {
    return res.status(400).json({ ok: false, error: 'You cannot deactivate your own account.' });
  }

  let updated = false;
  await runInTransaction('WRITE', async (tx) => {
    const result = await tx.run(
      `MATCH (i:Investigator {id: $id})
       WHERE i.email <> 'admin@cybercell.gov.in'
       SET i.isActive = $isActive
       RETURN i`,
      { id, isActive }
    );
    if (result.records.length > 0) {
      updated = true;
    }
  });

  if (updated) {
    logger.info('Investigator activation toggled', { targetId: id, isActive, updatedBy: req.investigator.id });
    res.json({ ok: true, message: `Account ${isActive ? 'activated' : 'deactivated'} successfully.` });
  } else {
    res.status(404).json({ ok: false, error: 'Investigator not found.' });
  }
}));
/**
 * DELETE /api/investigators/:id
 * Permanently deletes an investigator account.
 */
investigatorsRouter.delete('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;

  if (id === req.investigator.id) {
    return res.status(400).json({ ok: false, error: 'You cannot delete your own account.' });
  }

  let deleted = false;
  await runInTransaction('WRITE', async (tx) => {
    const result = await tx.run(
      `MATCH (i:Investigator {id: $id})
       WHERE i.email <> 'admin@cybercell.gov.in'
       DETACH DELETE i
       RETURN count(i) AS deletedCount`,
      { id }
    );
    if (Number(result.records[0].get('deletedCount')) > 0) {
      deleted = true;
    }
  });

  if (deleted) {
    logger.info('Investigator deleted', { targetId: id, deletedBy: req.investigator.id });
    res.json({ ok: true, message: 'Account permanently deleted.' });
  } else {
    res.status(404).json({ ok: false, error: 'Investigator not found.' });
  }
}));


