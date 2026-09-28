import { Router } from 'express';
import { runInTransaction } from '../services/neo4j.service.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const auditRouter = Router();

auditRouter.use(requireAuth);
auditRouter.use(requireRole(['SUPERVISOR']));

/**
 * GET /api/audit
 * Fetches the audit logs.
 */
auditRouter.get('/', asyncRoute(async (req, res) => {
  let logs = [];
  await runInTransaction('READ', async (tx) => {
    const result = await tx.run(
      `MATCH (a:AuditLog)
       RETURN a
       ORDER BY a.timestamp DESC
       LIMIT 100`
    );
    
    logs = result.records.map(record => {
      const node = record.get('a').properties;
      return {
        action: node.action,
        investigatorId: node.investigatorId,
        investigatorName: node.investigatorName,
        timestamp: node.timestamp ? node.timestamp.toString() : new Date().toISOString(),
        details: node.details ? JSON.parse(node.details) : {}
      };
    });
  });

  res.json({ ok: true, logs });
}));
