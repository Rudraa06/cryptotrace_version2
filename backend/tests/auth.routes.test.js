import request from 'supertest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/services/neo4j.service.js';
import bcrypt from 'bcrypt';
import RedisMock from 'ioredis-mock';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only-do-not-use-in-prod';

describe('Auth Layer and RBAC', () => {
  let app;

  beforeAll(async () => {
    app = createApp();
    
    // Clear out test data and seed
    await runInTransaction('WRITE', async (tx) => {
      await tx.run(`MATCH (i:Investigator {email: "test_investigator@cybercell.gov.in"}) DETACH DELETE i`);
      await tx.run(`MATCH (i:Investigator {email: "test_inactive@cybercell.gov.in"}) DETACH DELETE i`);
      await tx.run(`MATCH (c:Case {id: "TEST-CASE-123"}) DETACH DELETE c`);
      await tx.run(`MATCH (c:Case {id: "TEST-CASE-456"}) DETACH DELETE c`);
      
      const passwordHash = await bcrypt.hash('password123', 12);
      
      // Active investigator
      await tx.run(`
        CREATE (i:Investigator {
          id: "inv-active-1",
          email: "test_investigator@cybercell.gov.in",
          passwordHash: $passwordHash,
          name: "Test Active",
          role: "INVESTIGATOR",
          isActive: true
        })
      `, { passwordHash });

      // Inactive investigator
      await tx.run(`
        CREATE (i:Investigator {
          id: "inv-inactive-1",
          email: "test_inactive@cybercell.gov.in",
          passwordHash: $passwordHash,
          name: "Test Inactive",
          role: "INVESTIGATOR",
          isActive: false
        })
      `, { passwordHash });

      // Create cases
      await tx.run(`
        MATCH (i:Investigator {id: "inv-active-1"})
        CREATE (c1:Case {id: "TEST-CASE-123", suspectWallet: "0xAssignedTarget"})
        CREATE (c1)-[:ASSIGNED_TO]->(i)
        CREATE (c2:Case {id: "TEST-CASE-456", suspectWallet: "0xUnassignedTarget"})
      `);
    });
  });

  afterAll(async () => {
    await runInTransaction('WRITE', async (tx) => {
      await tx.run(`MATCH (i:Investigator {email: "test_investigator@cybercell.gov.in"}) DETACH DELETE i`);
      await tx.run(`MATCH (i:Investigator {email: "test_inactive@cybercell.gov.in"}) DETACH DELETE i`);
      await tx.run(`MATCH (c:Case {id: "TEST-CASE-123"}) DETACH DELETE c`);
      await tx.run(`MATCH (c:Case {id: "TEST-CASE-456"}) DETACH DELETE c`);
    });
    // app.js creates its own redis connection that we can't easily mock here without unstable_mockModule
    // but the rate limiter allows testing natively if redis is alive, or failing.
    // For this test, we rely on the in-memory mock we pass? No, rateLimit uses app's redis if not injected.
    // express-rate-limit defaults to MemoryStore if rate-limit-redis isn't configured, but the app uses default MemoryStore anyway if we didn't inject redis!
    // Let's check app.js: "const globalLimiter = rateLimit({...})" -- it doesn't use Redis! It uses MemoryStore!
    // Ah! express-rate-limit uses memory by default. The rate limiter test DOES NOT use redis!
  });

  afterEach(async () => {
    // Relying on random emails
  });

  describe('requireAuth Middleware', () => {
    it('rejects missing tokens', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/No authentication token/i);
    });

    it('rejects invalid tokens', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', 'token=invalid.jwt.token');
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid authentication token/i);
    });

    it('rejects expired tokens', async () => {
      const expiredToken = jwt.sign({ id: 'inv-active-1' }, JWT_SECRET, { expiresIn: '-1h' });
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `token=${expiredToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Session expired/i);
    });

    it('rejects valid token for an isActive=false investigator', async () => {
      const token = jwt.sign({ id: 'inv-inactive-1' }, JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `token=${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Account deactivated or removed/i);
    });

    it('accepts valid token for active investigator', async () => {
      const token = jwt.sign({ id: 'inv-active-1' }, JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `token=${token}`);
      expect(res.status).toBe(200);
      expect(res.body.investigator.id).toBe('inv-active-1');
    });
  });

  describe('requireRole Middleware', () => {
    it('blocks INVESTIGATOR from /api/trace/correlate', async () => {
      const token = jwt.sign({ id: 'inv-active-1' }, JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app)
        .post('/api/trace/correlate')
        .set('Cookie', `token=${token}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ victimWallet: '0x123', suspectWallet: '0x456' });
      
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/required role/i);
    });
  });

  describe('Export Case-Assignment Checking', () => {
    it('blocks INVESTIGATOR exporting a case they are not assigned to', async () => {
      const token = jwt.sign({ id: 'inv-active-1' }, JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app)
        .post('/api/export/evidence')
        .set('Cookie', `token=${token}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ targetAddress: '0xUnassignedTarget', nodes: [] });
        
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not assigned to a case involving this address/i);
    });

    it('allows INVESTIGATOR exporting a case they are assigned to', async () => {
      const token = jwt.sign({ id: 'inv-active-1' }, JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app)
        .post('/api/export/evidence')
        .set('Cookie', `token=${token}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ targetAddress: '0xAssignedTarget', nodes: [] });
      
      expect(res.status).not.toBe(403);
    });
  });

  describe('Login Rate-Limiting', () => {
    it('locks out after the threshold (5 attempts)', async () => {
      const randomEmail = `test_rate_limit_${Date.now()}@cybercell.gov.in`;
      
      // 5 failed attempts
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', '127.0.0.1')
          .send({ email: randomEmail, password: 'wrong' });
      }

      // 6th attempt should hit rate limit
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '127.0.0.1')
        .send({ email: randomEmail, password: 'wrong' });
      
      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/Too many failed login attempts/i);
    });
  });
});
