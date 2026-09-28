import { runInTransaction } from './neo4j.service.js';
import { logger } from '../lib/logger.js';

/**
 * Logs an action to the Neo4j audit trail.
 * 
 * @param {string} action The action being performed (e.g., 'TRACE_QUERY', 'EXPORT_EVIDENCE')
 * @param {object} investigator The full investigator object from req.investigator
 * @param {object} details Additional metadata to log
 */
export async function logAuditAction(action, investigator, details) {
  try {
    const investigatorId = investigator?.id || 'UNKNOWN';
    const investigatorName = investigator?.name || 'Unknown Investigator';
    
    const query = `
      CREATE (a:AuditLog {
        action: $action,
        investigatorId: $investigatorId,
        investigatorName: $investigatorName,
        timestamp: datetime(),
        details: $details
      })
    `;
    await runInTransaction('WRITE', async (tx) => {
      await tx.run(query, { action, investigatorId, investigatorName, details: JSON.stringify(details) });
    });
    logger.info(`[Audit] ${action} by ${investigatorId} (${investigatorName})`);
  } catch (err) {
    logger.error(`[Audit] Failed to log action ${action}: ${err.message}`);
  }
}
