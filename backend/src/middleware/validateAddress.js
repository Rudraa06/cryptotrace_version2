/**
 * middleware/validateAddress.js
 * ---------------------------------------------------------------------------
 * Validates and normalises the `:address` route parameter, and parses `?depth`.
 *
 * Doing this in middleware rather than inside each handler means route logic can
 * assume `req.trace` is present and well-formed. It also gives us one place to
 * reject malformed input before any RPC quota is spent on it.
 */

import { isValidAddress, normalizeAddress, toChecksum, InvalidAddressError } from '../lib/addresses.js';
import { config } from '../config/env.js';

/**
 * Express middleware. On success attaches:
 *   req.trace = { address, addressDisplay, depth, depthWasClamped }
 */
export function validateAddressParam(req, res, next) {
  const raw = req.params.address;

  if (!isValidAddress(raw)) {
    // Delegate to the central error handler, which maps this to 400.
    next(new InvalidAddressError(raw));
    return;
  }

  // --- Parse ?depth --------------------------------------------------------
  // Absent is fine (use the default). Present but non-numeric is a caller bug
  // and we say so, rather than silently substituting the default - a silent
  // fallback here is how you end up demoing a 3-hop trace while insisting it is
  // 5 hops.
  let depth = config.defaultTraceDepth;
  let depthWasClamped = false;

  const rawDepth = req.query.depth;
  if (rawDepth !== undefined && rawDepth !== '') {
    const parsed = Number(rawDepth);

    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      const error = new Error(
        `Invalid "depth" query parameter: "${rawDepth}". Expected an integer between 1 and ${config.maxTraceDepth}.`
      );
      error.statusCode = 400;
      next(error);
      return;
    }

    if (parsed < 1) {
      const error = new Error('"depth" must be at least 1.');
      error.statusCode = 400;
      next(error);
      return;
    }

    depth = Math.min(parsed, config.maxTraceDepth);
    depthWasClamped = parsed > config.maxTraceDepth;
  }

  const address = normalizeAddress(raw);

  req.trace = {
    address,
    addressDisplay: toChecksum(address),
    depth,
    depthWasClamped,
  };

  next();
}
