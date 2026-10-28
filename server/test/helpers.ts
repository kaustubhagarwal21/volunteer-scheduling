import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/passwords';
import type { AuthUser, Role } from '../src/auth/types';
import { pool } from '../src/db/pool';
import { addDays, orgClock } from '../src/time/orgClock';

export const app = createApp();
export const PASSWORD = 'password123';

let counter = 0;
/** Unique suffix so every test builds its own users/programs and never collides with another test. */
export function unique(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

let passwordHash: Promise<string> | undefined;

export async function createUser(role: Role, name?: string): Promise<AuthUser> {
  passwordHash ??= hashPassword(PASSWORD);
  const tag = unique();
  const { rows } = await pool.query<AuthUser>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role`,
    [`${role}-${tag}@test.local`, name ?? `${role} ${tag}`, await passwordHash, role],
  );
  return rows[0];
}

export type Agent = ReturnType<typeof request.agent>;

/** A supertest agent that keeps cookies between requests, signed in as `user`. */
export async function signIn(user: AuthUser): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** Organisation-local date `days` from today, 'YYYY-MM-DD'. */
export function dayFromToday(days: number): string {
  return addDays(orgClock().today, days);
}

export async function createProgram(createdBy: AuthUser, name = `Program ${unique()}`) {
  const { rows } = await pool.query<{ id: number; name: string }>(
    'INSERT INTO programs (name, created_by) VALUES ($1, $2) RETURNING id, name',
    [name, createdBy.id],
  );
  return rows[0];
}

export async function addMember(programId: number, user: AuthUser, addedBy: AuthUser) {
  await pool.query('INSERT INTO program_members (program_id, user_id, added_by) VALUES ($1, $2, $3)', [
    programId,
    user.id,
    addedBy.id,
  ]);
}

/**
 * Inserts a shift directly, bypassing the API's "must start in the future" rule, so tests can
 * build past shifts (to close them) as well as future ones.
 */
export async function insertShift(
  programId: number,
  createdBy: AuthUser,
  shift: { date: string; startTime?: string; durationMinutes?: number; requiredHeadcount?: number; location?: string },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO shifts (program_id, shift_date, start_time, duration_minutes, location, required_headcount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      programId,
      shift.date,
      shift.startTime ?? '10:00',
      shift.durationMinutes ?? 120,
      shift.location ?? 'Community Hall',
      shift.requiredHeadcount ?? 2,
      createdBy.id,
    ],
  );
  await pool.query("INSERT INTO shift_events (shift_id, event_type, actor_id) VALUES ($1, 'created', $2)", [
    rows[0].id,
    createdBy.id,
  ]);
  return rows[0].id;
}

/** A coordinator, a program, and `volunteerCount` members, all signed in. */
export async function setupProgram(volunteerCount = 3) {
  const coordinator = await createUser('coordinator');
  const program = await createProgram(coordinator);
  const volunteers: AuthUser[] = [];
  for (let i = 0; i < volunteerCount; i += 1) {
    const volunteer = await createUser('volunteer');
    await addMember(program.id, volunteer, coordinator);
    volunteers.push(volunteer);
  }
  return {
    coordinator,
    program,
    volunteers,
    coord: await signIn(coordinator),
    vols: await Promise.all(volunteers.map((v) => signIn(v))),
  };
}

export async function shiftState(shiftId: number): Promise<{ state: string; signup_count: number }> {
  const { rows } = await pool.query('SELECT state, signup_count FROM shifts WHERE id = $1', [shiftId]);
  return rows[0];
}

export async function eventsFor(shiftId: number) {
  const { rows } = await pool.query(
    'SELECT event_type, from_state, to_state, actor_id, volunteer_id, note, details FROM shift_events WHERE shift_id = $1 ORDER BY id',
    [shiftId],
  );
  return rows;
}
