/**
 * services/alertEngine.service.js
 * ---------------------------------------------------------------------------
 * PHASE 7: Automated Alert Generation
 * 
 * Evaluates completed traces for critical patterns and generates actionable
 * alerts for law enforcement when thresholds are met.
 * 
 * NOTE: For the hackathon demo, alerts are stored in-memory and logged to the
 * console. In production, this would trigger webhooks to a central LEA dashboard,
 * send SMS/Email notifications to assigned officers, or queue messages in a broker.
 */

import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { publishCrossCaseAlert } from './realtime.service.js';

// In-memory store for the hackathon
const alerts = [];

export const alertRouter = Router();

/**
 * GET /api/alerts
 * Returns the recent alerts in reverse chronological order.
 */
alertRouter.get('/alerts', (req, res) => {
  res.json({ ok: true, count: alerts.length, alerts: alerts.slice().reverse() });
});

/**
 * Hook to evaluate a completed trace and generate alerts.
 * 
 * @param {object} enrichedTrace - The fully enriched trace result
 * @param {string} caseId - Optional case ID
 */
export function evaluateTrace(enrichedTrace, caseId = 'UNASSIGNED') {
  if (!enrichedTrace || !enrichedTrace.found) return;

  const walletAddress = enrichedTrace.query?.address || 'Unknown';
  let maxRiskScore = 0;
  
  if (enrichedTrace.forceGraph && Array.isArray(enrichedTrace.forceGraph.nodes)) {
    maxRiskScore = Math.max(
      ...enrichedTrace.forceGraph.nodes.map(n => n.riskScore || 0)
    );
  }

  const exchangeReached = Array.isArray(enrichedTrace.paths) && enrichedTrace.paths.length > 0;
  
  const reasons = [];
  if (maxRiskScore >= 80) {
    reasons.push(`High risk score detected (${maxRiskScore})`);
  }
  if (exchangeReached) {
    reasons.push(`Funds successfully traced to a known exchange endpoint`);
  }

  // Check for shared mule infrastructure across cases
  if (enrichedTrace.forceGraph && Array.isArray(enrichedTrace.forceGraph.nodes)) {
    const crossCaseNodes = enrichedTrace.forceGraph.nodes.filter(
      n => n.crossCaseAlert || (n.crossCaseIds && n.crossCaseIds.length > 1)
    );

    for (const ccNode of crossCaseNodes) {
      const casesStr = ccNode.crossCaseIds ? ccNode.crossCaseIds.join(', ') : 'multiple complaints';
      const label = ccNode.label || ccNode.id.slice(0, 10);
      const ccAlert = {
        caseId,
        walletAddress: ccNode.id,
        reason: `CRITICAL: Shared Mule Infrastructure Detected! Intermediary wallet ${label} is shared across cases (${casesStr}).`,
        riskScore: 100,
        isCrossCase: true,
        sharedWallet: ccNode.id,
        sharedCases: ccNode.crossCaseIds,
        timestamp: new Date().toISOString()
      };
      alerts.push(ccAlert);
      logger.warn('[ALERT ENGINE] Automated CROSS-CASE alert generated!', ccAlert);
      
      // Dispatch real-time alert via Redis Pub/Sub
      publishCrossCaseAlert(ccAlert);
    }
  }

  // If thresholds met, generate standard case alert
  if (reasons.length > 0) {
    const alert = {
      caseId,
      walletAddress,
      reason: reasons.join(' AND '),
      riskScore: maxRiskScore,
      exchangeReached,
      timestamp: new Date().toISOString()
    };

    alerts.push(alert);
    
    // Log clearly to console per the requirement
    logger.warn('[ALERT ENGINE] Automated alert generated!', alert);
  }
}
