import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, createUser, PASSWORD, signIn, unique } from './helpers';

describe('registration', () => {
  it('creates a volunteer account and signs it in', async () => {
    const agent = request.agent(app);
    const email = `new-${unique()}@test.local`;
    const res = await agent.post('/api/auth/register').send({ name: 'New Person', email, password: 'longenough' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, name: 'New Person', role: 'volunteer' });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
  });

  it('refuses any attempt to choose a role', async () => {
    const email = `sneaky-${unique()}@test.local`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Sneaky', email, password: 'longenough', role: 'coordinator' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/role/);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'longenough' });
    expect(login.status).toBe(401);
  });

  it('accepts a mixed-case email at sign-in', async () => {
    const user = await createUser('volunteer');
    const res = await request(app).post('/api/auth/login').send({ email: ` ${user.email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('normalises email case and rejects duplicates', async () => {
    const email = `Dup-${unique()}@Test.Local`;
    const first = await request(app).post('/api/auth/register').send({ name: 'A', email, password: 'longenough' });
    expect(first.body.user.email).toBe(email.toLowerCase());

    const second = await request(app)
      .post('/api/auth/register')
      .send({ name: 'B', email: email.toUpperCase(), password: 'longenough' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('explains every invalid field', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: '', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });
});

describe('sign in and out', () => {
  it('sets an httpOnly, SameSite=Lax session cookie', async () => {
    const user = await createUser('volunteer');
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sid=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const user = await createUser('volunteer');
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: user.email, password: 'wrong-pass' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: `ghost-${unique()}@test.local`, password: PASSWORD });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }
  });

  it('logout invalidates the session on the server, not just the cookie', async () => {
    const user = await createUser('coordinator');
    const agent = await signIn(user);
    const cookie = (await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }))
      .headers['set-cookie'];

    // Log out the second session, then replay its old cookie by hand.
    await request(app).post('/api/auth/logout').set('Cookie', cookie).send({});
    const replay = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    // The first session is unaffected.
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects requests without a session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
