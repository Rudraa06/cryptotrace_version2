import { config } from '../config/env.js';

/**
 * Middleware to enforce API key authentication on protected routes.
 * Validates the X-API-Key header against the INTERNAL_API_KEY environment variable.
 */
export function requireApiKey(req, res, next) {
  const apiKey = req.get('X-API-Key') || req.query.apiKey;

  if (!apiKey || apiKey !== config.internalApiKey) {
    return res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Valid X-API-Key header or apiKey query param is required.',
      }
    });
  }
  // Phase 2A Auth Tie-In: Resolve the API key to an actual investigator record.
  // In production, this would be a DB lookup or JWT payload extraction.
  req.investigator = {
    id: apiKey,
    name: apiKey === config.internalApiKey ? 'Agent Jane Doe (Demo Investigator)' : 'Unknown Investigator'
  };

  next();
}
