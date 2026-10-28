import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, createUser, signIn } from './helpers';

describe('API basics', () => {
  it('responds to the health check without a session', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('denies by default: any non-public route needs a session, even unknown ones', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(401);
  });

  it('returns a JSON 404 for unknown API routes once signed in', async () => {
    const agent = await signIn(await createUser('volunteer'));
    const res = await agent.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('refuses state-changing requests that are not JSON (CSRF safeguard)', async () => {
    const res = await request(app).post('/api/auth/login').type('form').send('email=a@b.c&password=x');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('JSON_REQUIRED');
  });
});
