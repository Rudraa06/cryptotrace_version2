import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { jest } from '@jest/globals';

describe('Trace API Routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should reject unauthenticated requests', async () => {
    const res = await request(app).get('/api/trace/0x1234567890123456789012345678901234567890');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should validate the address parameter', async () => {
    const res = await request(app)
      .get('/api/trace/invalid-address')
      .set('X-API-Key', config.internalApiKey);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_ADDRESS');
  });

});
