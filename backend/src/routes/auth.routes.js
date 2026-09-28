import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import RedisReal from 'ioredis';
import RedisMock from 'ioredis-mock';
import { runInTransaction } from '../services/neo4j.service.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import crypto from 'crypto';
import { sendPasswordResetEmail } from '../services/email.service.js';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only-do-not-use-in-prod';
const Redis = process.env.NODE_ENV === 'test' ? RedisMock : RedisReal;

export const authRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => (times > 3 ? null : 50)
});

authRedis.on('error', (err) => {
  if (err.code !== 'ECONNREFUSED') {
    logger.error('Redis connection error in auth service', { error: err.message });
  }
});

// Rate Limiting parameters
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_SEC = 15 * 60; // 15 minutes

/**
 * POST /api/auth/login
 * Validates email/password against the Neo4j Investigator nodes.
 * Enforces per-IP + per-Email rate limiting via Redis.
 */
authRouter.post('/login', asyncRoute(async (req, res) => {
  const email = req.body.email?.trim();
  const password = req.body.password?.trim();
  
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: { message: 'Email and password required.' } });
  }

  const ip = req.ip || req.connection.remoteAddress;
  const ipKey = `ratelimit:login:ip:${ip}`;
  const emailKey = `ratelimit:login:email:${email.toLowerCase()}`;

  // 1. Check Rate Limits
  // If Redis is down, fail open (allow the login attempt) rather than crashing
  const [ipAttempts, emailAttempts] = await Promise.all([
    authRedis.get(ipKey).catch(handleRedisError),
    authRedis.get(emailKey).catch(handleRedisError)
  ]);

  if (Number(ipAttempts) >= MAX_ATTEMPTS || Number(emailAttempts) >= MAX_ATTEMPTS) {
    logger.warn('Login rate limit exceeded', { email, ip });
    return res.status(429).json({ 
      ok: false, 
      error: { message: 'Too many failed login attempts. Please try again in 15 minutes.' }
    });
  }

  // 2. Fetch Investigator
  let investigator = null;
  await runInTransaction('READ', async (tx) => {
    const result = await tx.run(
      `MATCH (i:Investigator {email: $email}) RETURN i`,
      { email: email.toLowerCase() }
    );
    if (result.records.length > 0) {
      investigator = result.records[0].get('i').properties;
    }
  });

  if (!investigator || !investigator.isActive) {
    await incrementRateLimit(ipKey, emailKey);
    return res.status(401).json({ ok: false, error: { message: 'Invalid credentials.' } });
  }

  // 3. Verify Password
  
    const validPassword = await bcrypt.compare(password, investigator.passwordHash);
  if (!validPassword) {
    await incrementRateLimit(ipKey, emailKey);
    return res.status(401).json({ ok: false, error: { message: 'Invalid credentials.' } });
  }

  // 4. Success - Clear Rate Limits
  await Promise.all([
    authRedis.del(ipKey).catch(handleRedisError),
    authRedis.del(emailKey).catch(handleRedisError)
  ]);

  // 5. MFA Check
  if (!investigator.mfaEnabled) {
    const tempToken = jwt.sign({ tempId: investigator.id, requireSetup: true }, JWT_SECRET, { expiresIn: '15m' });
    return res.json({ ok: true, requiresMfaSetup: true, tempToken });
  } else {
    const tempToken = jwt.sign({ tempId: investigator.id }, JWT_SECRET, { expiresIn: '15m' });
    return res.json({ ok: true, requiresMfa: true, tempToken });
  }
}));

/**
 * POST /api/auth/mfa/setup
 * Generates an MFA secret and QR code for a user who needs setup.
 */
authRouter.post('/mfa/setup', asyncRoute(async (req, res) => {
  const { tempToken } = req.body;
  if (!tempToken) return res.status(401).json({ ok: false, error: 'Missing temp token.' });

  try {
    const decoded = jwt.verify(tempToken, JWT_SECRET);
    if (!decoded.requireSetup) return res.status(400).json({ ok: false, error: 'MFA already setup.' });

    let email = '';
    await runInTransaction('READ', async (tx) => {
      const result = await tx.run('MATCH (i:Investigator {id: $id}) RETURN i.email AS email', { id: decoded.tempId });
      if (result.records.length > 0) email = result.records[0].get('email');
    });

    if (!email) return res.status(404).json({ ok: false, error: 'User not found.' });

    const secret = speakeasy.generateSecret({ name: `CryptoTrace (${email})` });
    const otpauth = secret.otpauth_url;
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    // Store secret temporarily in Neo4j
    await runInTransaction('WRITE', async (tx) => {
      await tx.run('MATCH (i:Investigator {id: $id}) SET i.tempMfaSecret = $secret', { id: decoded.tempId, secret: secret.base32 });
    });

    res.json({ ok: true, secret: secret.base32, qrCodeDataUrl });
  } catch (err) {
    res.status(401).json({ ok: false, error: { message: 'Invalid or expired temp token.' } });
  }
}));

/**
 * POST /api/auth/mfa/verify
 * Verifies the 6-digit code. If valid, completes login and issues real session cookie.
 */
authRouter.post('/mfa/verify', asyncRoute(async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ ok: false, error: { message: 'Token and code required.' } });

  try {
    const decoded = jwt.verify(tempToken, JWT_SECRET);
    
    let investigator = null;
    await runInTransaction('READ', async (tx) => {
      const result = await tx.run('MATCH (i:Investigator {id: $id}) RETURN i', { id: decoded.tempId });
      if (result.records.length > 0) investigator = result.records[0].get('i').properties;
    });

    if (!investigator) return res.status(404).json({ ok: false, error: 'User not found.' });

    const secret = decoded.requireSetup ? investigator.tempMfaSecret : investigator.mfaSecret;
    if (!secret) return res.status(400).json({ ok: false, error: { message: 'No MFA secret found.' } });

    const isValid = speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: code,
      window: 1 // Allow 30s before/after
    });
    
    if (!isValid) return res.status(401).json({ ok: false, error: { message: 'Invalid authentication code.' } });

    // If this was setup, persist the secret and enable MFA
    if (decoded.requireSetup) {
      await runInTransaction('WRITE', async (tx) => {
        await tx.run(
          'MATCH (i:Investigator {id: $id}) SET i.mfaEnabled = true, i.mfaSecret = $secret, i.tempMfaSecret = null',
          { id: investigator.id, secret }
        );
      });
      investigator.mfaEnabled = true;
    }

    // Issue real JWT
    const token = jwt.sign(
      { id: investigator.id, role: investigator.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 12 * 60 * 60 * 1000 // 12 hours
    });

    logger.info('Investigator logged in successfully with MFA', { id: investigator.id, email: investigator.email });

    res.json({
      ok: true,
      investigator: {
        id: investigator.id,
        name: investigator.name,
        email: investigator.email,
        role: investigator.role,
        department: investigator.department
      },
      token: token // Return token for localStorage fallback in strict browsers
    });

  } catch (err) {
    res.status(401).json({ ok: false, error: { message: 'Invalid or expired temp token.' } });
  }
}));

/**
 * POST /api/auth/logout
 * Clears the HttpOnly JWT cookie.
 */
authRouter.post('/logout', requireAuth, asyncRoute(async (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
  });
  logger.info('Investigator logged out', { id: req.investigator.id });
  res.json({ ok: true, message: 'Logged out successfully.' });
}));

/**
 * GET /api/auth/me
 * Returns the current authenticated investigator's profile.
 */
authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    investigator: {
      id: req.investigator.id,
      name: req.investigator.name,
      email: req.investigator.email,
      role: req.investigator.role,
      department: req.investigator.department
    }
  });
}));

async function incrementRateLimit(ipKey, emailKey) {
  const multi = authRedis.multi();
  multi.incr(ipKey);
  multi.expire(ipKey, LOCKOUT_DURATION_SEC, 'NX');
  multi.incr(emailKey);
  multi.expire(emailKey, LOCKOUT_DURATION_SEC, 'NX');
  await multi.exec().catch(handleRedisError);
}

function handleRedisError(err) {
  const isConnectionError = 
    err.name === 'MaxRetriesPerRequestError' || 
    err.code === 'ECONNREFUSED' || 
    err.message?.includes('connect ECONNREFUSED');
    
  if (isConnectionError) {
    logger.warn('Redis connection unavailable. Rate limit check failed open.');
  } else {
    logger.error('APPLICATION BUG: Redis rate limiter threw an unexpected error', {
      error: err.message,
      stack: err.stack,
      name: err.name
    });
  }
  return null; // Always fail open for availability
}
/**
 * POST /api/auth/activate
 * Activates an account and sets the password using the activation token.
 */
authRouter.post('/activate', asyncRoute(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ ok: false, error: 'Token and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  }

  let activated = false;
  await runInTransaction('WRITE', async (tx) => {
    // Find the user with this token where expiry > now
    const result = await tx.run(
      `MATCH (i:Investigator {activationToken: $token})
       WHERE i.activationExpiry > toInteger(datetime().epochMillis)
       RETURN i`,
      { token }
    );

    if (result.records.length === 0) {
      throw new Error('Invalid or expired activation token.');
    }

    const investigator = result.records[0].get('i').properties;
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update the node
    await tx.run(
      `MATCH (i:Investigator {id: $id})
       SET i.passwordHash = $hashedPassword,
           i.isActive = true,
           i.activationToken = null,
           i.activationExpiry = null
       RETURN i`,
      { id: investigator.id, hashedPassword }
    );
    activated = true;
  });

  if (activated) {
    logger.info('Account activated successfully via token.');
    res.json({ ok: true, message: 'Account activated successfully. You may now log in.' });
  }
}));
/**
 * POST /api/auth/forgot-password
 * Generates a password reset token and sends an email.
 */
authRouter.post('/forgot-password', asyncRoute(async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email is required.' });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const tokenExpiry = Date.now() + (60 * 60 * 1000); // 1 hour

  let userExists = false;
  await runInTransaction('WRITE', async (tx) => {
    const result = await tx.run(
      `MATCH (i:Investigator {email: $email})
       SET i.resetToken = $resetToken,
           i.resetExpiry = $tokenExpiry
       RETURN i`,
      { email: email.toLowerCase(), resetToken, tokenExpiry }
    );
    if (result.records.length > 0) {
      userExists = true;
    }
  });

  if (userExists) {
    try {
      await sendPasswordResetEmail(email, resetToken);
    } catch (err) {
      logger.error('Failed to send password reset email', { error: err.message });
    }
  }

  // Always return success to prevent email enumeration
  res.json({ ok: true, message: 'If an account with that email exists, a password reset link has been sent.' });
}));

/**
 * POST /api/auth/reset-password
 * Resets the password using a valid token.
 */
authRouter.post('/reset-password', asyncRoute(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ ok: false, error: 'Token and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  }

  let reset = false;
  await runInTransaction('WRITE', async (tx) => {
    const result = await tx.run(
      `MATCH (i:Investigator {resetToken: $token})
       WHERE i.resetExpiry > toInteger(datetime().epochMillis)
       RETURN i`,
      { token }
    );

    if (result.records.length === 0) {
      throw new Error('Invalid or expired password reset token.');
    }

    const investigator = result.records[0].get('i').properties;
    const hashedPassword = await bcrypt.hash(password, 10);

    await tx.run(
      `MATCH (i:Investigator {id: $id})
       SET i.passwordHash = $hashedPassword,
           i.resetToken = null,
           i.resetExpiry = null
       RETURN i`,
      { id: investigator.id, hashedPassword }
    );
    reset = true;
  });

  if (reset) {
    logger.info('Password reset successfully via token.');
    res.json({ ok: true, message: 'Password reset successfully. You may now log in.' });
  }
}));










