import jwt from 'jsonwebtoken';
import { runInTransaction } from '../services/neo4j.service.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only-do-not-use-in-prod';

/**
 * Middleware to enforce JWT authentication and populate req.investigator.
 * Also checks Neo4j for instant revocation (isActive).
 */
export const requireAuth = async (req, res, next) => {
  // Check for X-API-Key first to allow ML-service and internal automated calls to bypass JWT
  const apiKey = req.get('X-API-Key');
  if (apiKey && apiKey === process.env.INTERNAL_API_KEY) {
    req.investigator = {
      id: 'internal_service',
      name: 'Internal Service System Account',
      email: 'system@cybercell.gov.in',
      role: 'SUPERVISOR', // Internal service is trusted
      department: 'System'
    };
    return next();
  }

  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'No authentication token provided.' } });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Revocation check
    let investigator = null;
    await runInTransaction('READ', async (tx) => {
      const result = await tx.run(
        `MATCH (i:Investigator {id: $id}) RETURN i.id AS id, i.email AS email, i.name AS name, i.role AS role, i.department AS department, i.isActive AS isActive`,
        { id: decoded.id }
      );
      if (result.records.length > 0) {
        investigator = {
          id: result.records[0].get('id'),
          email: result.records[0].get('email'),
          name: result.records[0].get('name'),
          role: result.records[0].get('role'),
          department: result.records[0].get('department'),
          isActive: result.records[0].get('isActive')
        };
      }
    });

    if (!investigator || !investigator.isActive) {
      // Token is valid but user was deleted or deactivated
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Account deactivated or removed.' } });
    }

    req.investigator = investigator;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: { code: 'TOKEN_EXPIRED', message: 'Session expired. Please log in again.' } });
    }
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token.' } });
  }
};

/**
 * Role-based access control middleware.
 * Must be used AFTER requireAuth.
 */
export const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    console.log('REQUIRE_ROLE', allowedRoles, req.investigator?.role); if (!req.investigator || !allowedRoles.includes(req.investigator.role)) {
      return res.status(403).json({
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have the required role to perform this action.'
        }
      });
    }
    next();
  };
};

/**
 * CSRF mitigation for state-changing endpoints.
 * Requires a custom header which browsers prevent cross-origin scripts from setting.
 */
export const requireCsrf = (req, res, next) => {
  // If request is from our own frontend, it will set this header.
  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.get('X-CSRF-Token')) {
    return next();
  }
  // Allow INTERNAL_API_KEY (used by ML service or automated tasks) to bypass
  if (req.get('X-API-Key') === process.env.INTERNAL_API_KEY) {
    return next();
  }
  return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'CSRF token missing or invalid.' } });
};
