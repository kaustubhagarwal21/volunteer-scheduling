import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/types';
import { pool } from '../src/db/pool';
import {
  addMember,
  app,
  createProgram,
  createUser,
  dayFromToday,
  insertShift,
  insertSignup,
  PASSWORD,
  setupProgram,
  shiftState,
  signIn,
  unique,
  type Agent,
} from './helpers';

/*
 * Goal 1, enforced by the server rather than by the UI:
 *   - signed out: 401 everywhere except health, register, login and logout;
 *   - volunteer: 403 on every coordinator-only route, even inside a program they belong to;
 *   - volunteer outside a program: 404, so nothing about that program is revealed;
 *   - coordinator: everything, in every program.
 */

/** A valid id (it fits INTEGER) that no test database will ever reach. */
const NO_SUCH_ID = 2_147_483_647;

type Method = 'get' | 'post' | 'patch' | 'delete';

/** A client with no session cookie. */
const anonymous = (): Agent => request(app);

/** Sends one request. Writes always go as JSON, because the API refuses anything else (415). */
function call(client: Agent, method: Method, path: string, body: object = {}) {
  const req = client[method](path);
  return method === 'get' ? req : req.send(body);
}

/**
 * Everything a request about one program could write, so a refused request can be shown to have
 * changed nothing. `actor` also catches a new program created by the person who was refused.
 */
async function snapshot(programId: number, actor: AuthUser) {
  const { rows } = await pool.query(
    `SELECT (SELECT row_to_json(p) FROM programs p WHERE p.id = $1) AS program,
            (SELECT json_agg(pm ORDER BY pm.user_id) FROM program_members pm WHERE pm.program_id = $1) AS members,
            (SELECT json_agg(s ORDER BY s.id) FROM shifts s WHERE s.program_id = $1) AS shifts,
            (SELECT json_agg(su ORDER BY su.id) FROM signups su JOIN shifts s ON s.id = su.shift_id
              WHERE s.program_id = $1) AS signups,
            (SELECT count(*) FROM shift_events e JOIN shifts s ON s.id = e.shift_id WHERE s.program_id = $1) AS events,
            (SELECT count(*) FROM programs WHERE created_by = $2) AS programs_created_by_actor`,
    [programId, actor.id],
  );
  return rows[0];
}

/** One program with two volunteer members, ready for every coordinator action to succeed. */
interface World {
  coordinator: AuthUser;
  program: { id: number; name: string };
  /** The volunteer who makes the requests. */
  member: AuthUser;
  otherMember: AuthUser;
  /** A volunteer in no program yet, for "add a member". */
  outsider: AuthUser;
  /** Two days away with nobody signed up: understaffed, so it has an alert to dismiss. */
  upcomingShiftId: number;
  /** Already over, so it can be closed. */
  pastShiftId: number;
  /** The member's own signup, made by the routes that need one. */
  ownSignupId?: number;
}

async function buildWorld(): Promise<World> {
  const coordinator = await createUser('coordinator');
  const program = await createProgram(coordinator);
  const member = await createUser('volunteer');
  const otherMember = await createUser('volunteer');
  await addMember(program.id, member, coordinator);
  await addMember(program.id, otherMember, coordinator);
  return {
    coordinator,
    program,
    member,
    otherMember,
    outsider: await createUser('volunteer'),
    upcomingShiftId: await insertShift(program.id, coordinator, { date: dayFromToday(2), requiredHeadcount: 3 }),
    pastShiftId: await insertShift(program.id, coordinator, { date: dayFromToday(-2) }),
  };
}

interface Route {
  /** The route as mounted under /api, e.g. 'POST /programs/:id/archive'. */
  name: string;
  method: Method;
  path: (w: World) => string;
  body?: (w: World) => object;
  /** Puts the world in the state where the request succeeds for someone allowed to make it. */
  prepare?: (w: World) => Promise<void>;
  /** The status for someone allowed to make the request. */
  allowedStatus: number;
}

const sendRoute = (client: Agent, route: Route, w: World) => call(client, route.method, route.path(w), route.body?.(w));

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const COORDINATOR_ONLY: Route[] = [
  {
    name: 'POST /programs',
    method: 'post',
    path: () => '/api/programs',
    body: () => ({ name: `Program ${unique()}`, description: 'A new program' }),
    allowedStatus: 201,
  },
  {
    name: 'PATCH /programs/:id',
    method: 'patch',
    path: (w) => `/api/programs/${w.program.id}`,
    body: () => ({ name: `Renamed ${unique()}` }),
    allowedStatus: 200,
  },
  {
    name: 'POST /programs/:id/archive',
    method: 'post',
    path: (w) => `/api/programs/${w.program.id}/archive`,
    allowedStatus: 200,
  },
  {
    name: 'POST /programs/:id/restore',
    method: 'post',
    path: (w) => `/api/programs/${w.program.id}/restore`,
    prepare: async (w) => {
      await pool.query('UPDATE programs SET archived_at = now() WHERE id = $1', [w.program.id]);
    },
    allowedStatus: 200,
  },
  {
    name: 'GET /programs/:id/members',
    method: 'get',
    path: (w) => `/api/programs/${w.program.id}/members`,
    allowedStatus: 200,
  },
  {
    name: 'POST /programs/:id/members',
    method: 'post',
    path: (w) => `/api/programs/${w.program.id}/members`,
    body: (w) => ({ userId: w.outsider.id }),
    allowedStatus: 201,
  },
  {
    name: 'DELETE /programs/:id/members/:userId',
    method: 'delete',
    path: (w) => `/api/programs/${w.program.id}/members/${w.otherMember.id}`,
    allowedStatus: 200,
  },
  {
    name: 'POST /programs/:id/shifts',
    method: 'post',
    path: (w) => `/api/programs/${w.program.id}/shifts`,
    body: () => ({ date: dayFromToday(10), startTime: '09:00', durationMinutes: 60, location: 'Annex', requiredHeadcount: 2 }),
    allowedStatus: 201,
  },
  {
    name: 'POST /programs/:id/shifts/generate',
    method: 'post',
    path: (w) => `/api/programs/${w.program.id}/shifts/generate`,
    body: () => ({
      startDate: dayFromToday(14),
      endDate: dayFromToday(27),
      dayOfWeek: weekday(dayFromToday(14)),
      startTime: '09:00',
      durationMinutes: 60,
      location: 'Annex',
      requiredHeadcount: 2,
    }),
    allowedStatus: 201,
  },
  {
    name: 'GET /programs/:id/roster.csv',
    method: 'get',
    path: (w) => `/api/programs/${w.program.id}/roster.csv`,
    allowedStatus: 200,
  },
  {
    name: 'PATCH /shifts/:id',
    method: 'patch',
    path: (w) => `/api/shifts/${w.upcomingShiftId}`,
    body: () => ({ location: 'Side entrance' }),
    allowedStatus: 200,
  },
  {
    name: 'DELETE /shifts/:id',
    method: 'delete',
    path: (w) => `/api/shifts/${w.upcomingShiftId}`,
    allowedStatus: 200,
  },
  {
    name: 'POST /shifts/:id/close',
    method: 'post',
    path: (w) => `/api/shifts/${w.pastShiftId}/close`,
    allowedStatus: 200,
  },
  {
    name: 'POST /shifts/:id/notes',
    method: 'post',
    path: (w) => `/api/shifts/${w.upcomingShiftId}/notes`,
    body: () => ({ note: 'Bring gloves' }),
    allowedStatus: 201,
  },
  {
    name: 'GET /users/volunteers',
    method: 'get',
    path: () => '/api/users/volunteers',
    allowedStatus: 200,
  },
  {
    name: 'POST /alerts/:shiftId/dismiss',
    method: 'post',
    path: (w) => `/api/alerts/${w.upcomingShiftId}/dismiss`,
    allowedStatus: 204,
  },
];

const EVERY_SIGNED_IN_USER: Route[] = [
  { name: 'GET /auth/me', method: 'get', path: () => '/api/auth/me', allowedStatus: 200 },
  { name: 'GET /me/programs', method: 'get', path: () => '/api/me/programs', allowedStatus: 200 },
  { name: 'GET /programs', method: 'get', path: () => '/api/programs', allowedStatus: 200 },
  { name: 'GET /programs/:id', method: 'get', path: (w) => `/api/programs/${w.program.id}`, allowedStatus: 200 },
  { name: 'GET /shifts', method: 'get', path: () => '/api/shifts', allowedStatus: 200 },
  { name: 'GET /shifts/:id', method: 'get', path: (w) => `/api/shifts/${w.upcomingShiftId}`, allowedStatus: 200 },
  {
    name: 'GET /shifts/:id/timeline',
    method: 'get',
    path: (w) => `/api/shifts/${w.upcomingShiftId}/timeline`,
    allowedStatus: 200,
  },
  {
    name: 'POST /shifts/:id/signups',
    method: 'post',
    path: (w) => `/api/shifts/${w.upcomingShiftId}/signups`,
    allowedStatus: 201,
  },
  {
    name: 'POST /signups/:id/cancel',
    method: 'post',
    path: (w) => `/api/signups/${w.ownSignupId}/cancel`,
    prepare: async (w) => {
      w.ownSignupId = await insertSignup(w.upcomingShiftId, w.member);
    },
    allowedStatus: 204,
  },
  { name: 'GET /alerts', method: 'get', path: () => '/api/alerts', allowedStatus: 200 },
  { name: 'GET /dashboard', method: 'get', path: () => '/api/dashboard', allowedStatus: 200 },
];

describe('signed-out requests', () => {
  // The only public routes. Every other route is in the matrix below.
  it('can still reach health, register, login and logout', async () => {
    const user = await createUser('volunteer');
    const responses = [
      await anonymous().get('/api/health'),
      await anonymous()
        .post('/api/auth/register')
        .send({ name: 'Newcomer', email: `newcomer-${unique()}@test.local`, password: 'longenough' }),
      await anonymous().post('/api/auth/login').send({ email: user.email, password: PASSWORD }),
      await anonymous().post('/api/auth/logout').send({}),
    ];
    expect(responses.map((res) => res.status)).toEqual([200, 201, 200, 204]);
  });

  it.each([...COORDINATOR_ONLY, ...EVERY_SIGNED_IN_USER])('$name is refused with 401 and changes nothing', async (route) => {
    const w = await buildWorld();
    await route.prepare?.(w);
    const before = await snapshot(w.program.id, w.member);

    const res = await sendRoute(anonymous(), route, w);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: expect.stringMatching(/sign in/i) });
    expect(await snapshot(w.program.id, w.member)).toEqual(before);
  });

  it('treats a made-up session cookie as signed out', async () => {
    const res = await anonymous().get('/api/programs').set('Cookie', `sid=made-up-${unique()}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('treats an expired session as signed out', async () => {
    const coordinator = await createUser('coordinator');
    const agent = await signIn(coordinator);
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [coordinator.id]);

    const res = await agent.get('/api/programs');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('coordinator-only routes', () => {
  it.each(COORDINATOR_ONLY)(
    '$name is refused with 403 for a volunteer in the program, and allowed for a coordinator',
    async (route) => {
      const w = await buildWorld();
      await route.prepare?.(w);
      const before = await snapshot(w.program.id, w.member);

      const refused = await sendRoute(await signIn(w.member), route, w);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/only coordinators/i) });
      expect(await snapshot(w.program.id, w.member)).toEqual(before);

      // The same request on the same data succeeds for a coordinator: only the role made the difference.
      const allowed = await sendRoute(await signIn(w.coordinator), route, w);
      expect(allowed.status).toBe(route.allowedStatus);
    },
  );
});

describe('routes for every signed-in user', () => {
  it.each(EVERY_SIGNED_IN_USER)('$name is open to a volunteer in the program', async (route) => {
    const w = await buildWorld();
    await route.prepare?.(w);
    const res = await sendRoute(await signIn(w.member), route, w);
    expect(res.status).toBe(route.allowedStatus);
  });
});

/** A volunteer who belongs to program A only, next to program B with a shift, a member and a signup. */
async function twoPrograms() {
  const coordinator = await createUser('coordinator');
  const programA = await createProgram(coordinator);
  const programB = await createProgram(coordinator);
  const volunteer = await createUser('volunteer');
  await addMember(programA.id, volunteer, coordinator);
  const bMember = await createUser('volunteer');
  await addMember(programB.id, bMember, coordinator);
  // Both shifts are two days away and short of people, so both raise understaffing alerts.
  const aShiftId = await insertShift(programA.id, coordinator, { date: dayFromToday(2) });
  const bShiftId = await insertShift(programB.id, coordinator, { date: dayFromToday(2) });
  const bSignupId = await insertSignup(bShiftId, bMember);
  return { coordinator, programA, programB, volunteer, bMember, aShiftId, bShiftId, bSignupId, agent: await signIn(volunteer) };
}

type TwoPrograms = Awaited<ReturnType<typeof twoPrograms>>;

interface Probe {
  name: string;
  method: Method;
  path: (f: TwoPrograms) => string;
  /** The same request for an id that exists nowhere. */
  missing: string;
}

const IN_ANOTHER_PROGRAM: Probe[] = [
  {
    name: 'open the program',
    method: 'get',
    path: (f) => `/api/programs/${f.programB.id}`,
    missing: `/api/programs/${NO_SUCH_ID}`,
  },
  {
    name: 'open one of its shifts',
    method: 'get',
    path: (f) => `/api/shifts/${f.bShiftId}`,
    missing: `/api/shifts/${NO_SUCH_ID}`,
  },
  {
    name: 'read the timeline of one of its shifts',
    method: 'get',
    path: (f) => `/api/shifts/${f.bShiftId}/timeline`,
    missing: `/api/shifts/${NO_SUCH_ID}/timeline`,
  },
  {
    name: 'sign up for one of its shifts',
    method: 'post',
    path: (f) => `/api/shifts/${f.bShiftId}/signups`,
    missing: `/api/shifts/${NO_SUCH_ID}/signups`,
  },
  {
    name: 'cancel a signup on one of its shifts',
    method: 'post',
    path: (f) => `/api/signups/${f.bSignupId}/cancel`,
    missing: `/api/signups/${NO_SUCH_ID}/cancel`,
  },
];

const ids = (items: { id: number }[]) => items.map((item) => item.id);

describe('a volunteer only sees the programs they belong to', () => {
  it.each(IN_ANOTHER_PROGRAM)('gets 404, not 403, trying to $name in a program they are not in', async (probe) => {
    const f = await twoPrograms();
    const before = await snapshot(f.programB.id, f.volunteer);

    const res = await call(f.agent, probe.method, probe.path(f));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/not a member/) });
    expect(await snapshot(f.programB.id, f.volunteer)).toEqual(before);
  });

  // The point of answering 404 instead of 403 is that the other program's contents stay hidden.
  // That only holds if the answer is the same as for an id that does not exist at all.
  it.each(IN_ANOTHER_PROGRAM)(
    'cannot tell whether it exists when trying to $name in another program',
    async (probe) => {
      const f = await twoPrograms();
      const hidden = await call(f.agent, probe.method, probe.path(f));
      const missing = await call(f.agent, probe.method, probe.missing);
      expect({ status: hidden.status, body: hidden.body }).toEqual({ status: missing.status, body: missing.body });
    },
  );

  it("finds none of another program's shifts, even filtering by its id or searching its name", async () => {
    const f = await twoPrograms();
    for (const query of [{ programId: f.programB.id }, { q: f.programB.name }]) {
      const res = await f.agent.get('/api/shifts').query(query);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 0, items: [] });
    }

    const everything = await f.agent.get('/api/shifts');
    expect(everything.body.total).toBe(1);
    expect(ids(everything.body.items)).toEqual([f.aShiftId]);
  });

  it('sees only their own program in the program list, their schedule, the alerts and the dashboard', async () => {
    const f = await twoPrograms();

    expect(ids((await f.agent.get('/api/programs')).body.programs)).toEqual([f.programA.id]);

    const schedule = (await f.agent.get('/api/me/programs')).body.programs;
    expect(ids(schedule)).toEqual([f.programA.id]);
    expect(ids(schedule[0].shifts)).toEqual([f.aShiftId]);

    const alerts = (await f.agent.get('/api/alerts')).body;
    expect(ids(alerts.alerts)).toEqual([f.aShiftId]);
    expect(alerts.count).toBe(1);

    // Program B's partially filled shift and its signup must not leak into the volunteer's numbers.
    const dashboard = (await f.agent.get('/api/dashboard')).body;
    expect(dashboard.byProgram.map((p: { programId: number }) => p.programId)).toEqual([f.programA.id]);
    expect(dashboard.byState).toEqual({ open: 1, partially_filled: 0, filled: 0, closed: 0 });
    expect(dashboard.headline.signupsThisWeek).toBe(0);
  });

  it("sees who else is on a shift in their program, but not their email addresses", async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4), requiredHeadcount: 3 });
    await insertSignup(shiftId, volunteers[1]);
    const onShift = (res: { body: { signups: { volunteer: unknown }[] } }) => res.body.signups.map((s) => s.volunteer);

    expect(onShift(await vols[0].get(`/api/shifts/${shiftId}`))).toEqual([
      { id: volunteers[1].id, name: volunteers[1].name },
    ]);
    expect(onShift(await coord.get(`/api/shifts/${shiftId}`))).toEqual([
      { id: volunteers[1].id, name: volunteers[1].name, email: volunteers[1].email },
    ]);
  });
});

describe('a volunteer acts only for themselves', () => {
  it('gets 403 signing up another member of their program, but may name themselves', async () => {
    const { coordinator, program, volunteers, vols } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4) });

    const forOther = await vols[0].post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[1].id });
    expect(forOther.status).toBe(403);
    expect(forOther.body.error).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/only sign themselves up/) });
    expect(await shiftState(shiftId)).toEqual({ state: 'open', signup_count: 0 });

    const forSelf = await vols[0].post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[0].id });
    expect(forSelf.status).toBe(201);
  });

  it("gets 403 cancelling another member's signup, and that signup stays", async () => {
    const { coordinator, program, volunteers, vols } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4) });
    const theirs = await insertSignup(shiftId, volunteers[1]);

    const res = await vols[0].post(`/api/signups/${theirs}/cancel`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/only cancel your own/) });
    expect(await shiftState(shiftId)).toEqual({ state: 'partially_filled', signup_count: 1 });
  });

  it('can cancel a signup a coordinator made on their behalf, because it is still theirs', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4) });
    const made = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[0].id });
    expect(made.status).toBe(201);

    expect((await vols[0].post(`/api/signups/${made.body.signup.id}/cancel`)).status).toBe(204);
    expect(await shiftState(shiftId)).toEqual({ state: 'open', signup_count: 0 });
  });
});

describe('coordinators', () => {
  it('can open and staff any program, including one another coordinator set up', async () => {
    const f = await twoPrograms();
    const coord = await signIn(await createUser('coordinator'));

    expect((await coord.get(`/api/programs/${f.programB.id}`)).status).toBe(200);
    expect(ids((await coord.get('/api/shifts').query({ programId: f.programB.id })).body.items)).toEqual([f.bShiftId]);

    const newcomer = await createUser('volunteer');
    await addMember(f.programB.id, newcomer, f.coordinator);
    const signedUp = await coord.post(`/api/shifts/${f.bShiftId}/signups`).send({ volunteerId: newcomer.id });
    expect(signedUp.status).toBe(201);
    expect((await coord.post(`/api/signups/${f.bSignupId}/cancel`)).status).toBe(204);
    expect(await shiftState(f.bShiftId)).toEqual({ state: 'partially_filled', signup_count: 1 });
  });
});

describe('roles cannot be chosen through the API', () => {
  it.each([
    { name: 'role: "coordinator"', extra: { role: 'coordinator' } },
    { name: 'isCoordinator: true', extra: { isCoordinator: true } },
    { name: 'roles: ["coordinator"]', extra: { roles: ['coordinator'] } },
  ])('registration refuses $name and creates no account', async ({ extra }) => {
    const email = `climber-${unique()}@test.local`;
    const res = await anonymous()
      .post('/api/auth/register')
      .send({ name: 'Climber', email, password: 'longenough', ...extra });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain(Object.keys(extra)[0]);
    expect((await pool.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount).toBe(0);
  });

  it('makes every self-registered account a volunteer, who is then refused coordinator-only routes', async () => {
    const agent = request.agent(app);
    const email = `self-${unique()}@test.local`;
    const registered = await agent.post('/api/auth/register').send({ name: 'Self Registered', email, password: 'longenough' });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe('volunteer');
    expect((await pool.query('SELECT role FROM users WHERE email = $1', [email])).rows).toEqual([{ role: 'volunteer' }]);

    const attempt = await agent.post('/api/programs').send({ name: `Program ${unique()}` });
    expect(attempt.status).toBe(403);
  });

  it('refuses a role at sign-in too, without starting a session', async () => {
    const volunteer = await createUser('volunteer');
    const res = await anonymous()
      .post('/api/auth/login')
      .send({ email: volunteer.email, password: PASSWORD, role: 'coordinator' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/role/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('checks the role stored in the database on every request, not one remembered by the session', async () => {
    const coordinator = await createUser('coordinator');
    const agent = await signIn(coordinator);
    expect((await agent.get('/api/users/volunteers')).status).toBe(200);

    await pool.query("UPDATE users SET role = 'volunteer' WHERE id = $1", [coordinator.id]);
    const res = await agent.get('/api/users/volunteers');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
