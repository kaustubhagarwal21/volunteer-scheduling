/**
 * Resets the database and fills it with demo data: `npm run seed`.
 *
 * History is append-only and signup counts are verified at commit, so the seed can't backfill
 * anything after the fact. Instead it replays a realistic past, in time order, with explicit
 * timestamps: shifts are created, volunteers sign up (and a few cancel), shifts fill up, finished
 * shifts are closed, coordinators leave notes. Everything is relative to "today" in ORG_TIMEZONE, so
 * re-running it before a demo always produces current data.
 */
import type { PoolClient } from 'pg';
import { hashPassword } from '../auth/passwords';
import { config } from '../config';
import { addDays, orgClock } from '../time/orgClock';
import { migrate } from './migrate';
import { pool, withTransaction } from './pool';

const clock = orgClock();
const TZ = config.ORG_TIMEZONE;

export const DEMO_PASSWORDS = { coordinator: 'coordinator123', volunteer: 'volunteer123' };

// ---------------------------------------------------------------------------------------------
// Small helpers

/** Deterministic pseudo-random numbers (mulberry32), so every run produces the same story. */
let seedState = 20261028;
function random(): number {
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Organisation-local wall-clock time as 'YYYY-MM-DD HH:MM:SS'; these strings sort chronologically. */
type Local = string;
function local(date: string, time: string, plusMinutes = 0): Local {
  const at = new Date(`${date}T${time}:00Z`);
  at.setUTCMinutes(at.getUTCMinutes() + plusMinutes);
  return at.toISOString().slice(0, 19).replace('T', ' ');
}
const minutesBetween = (from: Local, to: Local) =>
  (Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`)) / 60_000;
const earlier = (a: Local, b: Local) => (a < b ? a : b);
const later = (a: Local, b: Local) => (a > b ? a : b);

/** A random moment between two local times, moved into waking hours (08:00-21:59) where possible. */
const between = (from: Local, to: Local): Local => {
  const span = Math.max(0, minutesBetween(from, to));
  const at = local(from.slice(0, 10), from.slice(11, 16), Math.floor(random() * span));
  const hour = Number(at.slice(11, 13));
  const awakeHour = hour < 8 ? 8 + (hour % 6) : hour >= 22 ? 10 + (hour - 22) : hour;
  const moved = `${at.slice(0, 11)}${String(awakeHour).padStart(2, '0')}${at.slice(13)}`;
  return later(from, earlier(moved, to));
};

/** SQL for "this org-local time as an instant". */
const AT = (param: string) => `(${param}::timestamp AT TIME ZONE '${TZ}')`;

// ---------------------------------------------------------------------------------------------
// The cast

const COORDINATORS = [
  { name: 'Priya Sharma', email: 'coordinator@demo.org' },
  { name: 'Rahul Mehta', email: 'rahul.coordinator@demo.org' },
];

const VOLUNTEERS = [
  { name: 'Asha Rao', email: 'volunteer@demo.org' },
  { name: 'Ben Thomas', email: 'ben@demo.org' },
  { name: 'Kavya Nair', email: 'kavya@demo.org' },
  { name: 'Arjun Singh', email: 'arjun@demo.org' },
  { name: 'Meera Iyer', email: 'meera@demo.org' },
  { name: 'Rohan Das', email: 'rohan@demo.org' },
  { name: 'Sara Khan', email: 'sara@demo.org' },
  { name: 'Vikram Patel', email: 'vikram@demo.org' },
  { name: 'Neha Gupta', email: 'neha@demo.org' },
  { name: 'Imran Sheikh', email: 'imran@demo.org' },
  { name: 'Divya Menon', email: 'divya@demo.org' },
  { name: 'Karan Malhotra', email: 'karan@demo.org' },
  { name: 'Ananya Bose', email: 'ananya@demo.org' },
  { name: 'Farah Ali', email: 'farah@demo.org' },
  // Registered but not yet added to any program: shows what a brand-new volunteer sees.
  { name: 'Nikhil Jain', email: 'newcomer@demo.org' },
];

interface ProgramPlan {
  key: string;
  name: string;
  description: string;
  members: string[]; // volunteer emails
  archivedWeeksAgo?: number;
}

const PROGRAMS: ProgramPlan[] = [
  {
    key: 'pantry',
    name: 'Community Food Pantry',
    description:
      'Sort donations, pack grocery bags and run the Saturday distribution for about 120 families. ' +
      'Closed-toe shoes please; aprons and gloves are provided.',
    members: ['volunteer@demo.org', 'ben@demo.org', 'kavya@demo.org', 'arjun@demo.org', 'meera@demo.org', 'sara@demo.org', 'neha@demo.org', 'farah@demo.org'],
  },
  {
    key: 'trail',
    name: 'Weekend Trail Cleanup',
    description: 'Litter picking and path clearing along the Aravalli trails. Bring water and a hat; bags and grabbers are provided.',
    members: ['volunteer@demo.org', 'rohan@demo.org', 'vikram@demo.org', 'imran@demo.org', 'divya@demo.org', 'karan@demo.org', 'arjun@demo.org'],
  },
  {
    key: 'tutoring',
    name: 'After-school Tutoring Drive',
    description: 'Maths and English help for classes 6 to 8 at the public library. One tutor per three students.',
    members: ['volunteer@demo.org', 'ananya@demo.org', 'meera@demo.org', 'divya@demo.org', 'ben@demo.org'],
  },
  {
    key: 'monsoon',
    name: 'Monsoon Relief Collection',
    description: 'Collection point for dry rations and tarpaulins during the monsoon. Wound down for the season.',
    members: ['kavya@demo.org', 'rohan@demo.org', 'sara@demo.org', 'imran@demo.org', 'karan@demo.org'],
    archivedWeeksAgo: 4,
  },
];

interface ShiftPlan {
  program: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  location: string;
  headcount: number;
  /** Demo scenario this shift is set up for, if any. */
  scenario?: 'open-alert' | 'partial-alert' | 'refilled-after-dismissal' | 'dismissed-alert' | 'overlap-demo' | 'needs-closing';
  /** Book the demo volunteer on this shift. */
  bookAsha?: boolean;
}

/** Every date from `fromDay` to `toDay` days from today that falls on `weekday` (0 = Sunday). */
function weekly(weekday: number, fromDay: number, toDay: number): string[] {
  const dates: string[] = [];
  for (let day = fromDay; day <= toDay; day += 1) {
    const date = addDays(clock.today, day);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === weekday) dates.push(date);
  }
  return dates;
}

function planShifts(): ShiftPlan[] {
  const plans: ShiftPlan[] = [];
  const add = (program: string, dates: string[], startTime: string, durationMinutes: number, location: string, headcount: number) =>
    dates.forEach((date) => plans.push({ program, date, startTime, durationMinutes, location, headcount }));

  add('pantry', weekly(6, -56, 42), '09:00', 180, 'Community Hall, Sector 14', 5);
  add('pantry', weekly(3, -56, 28), '17:00', 120, 'Pantry Warehouse, Gate 2', 3);
  add('trail', weekly(0, -56, 42), '07:00', 180, 'Aravalli Trailhead, Gate 1', 6);
  add('tutoring', [...weekly(2, -42, 35), ...weekly(4, -42, 35)], '16:00', 120, 'Public Library, Room 2', 3);
  add('monsoon', weekly(6, -70, -35), '14:00', 180, 'Ward Office, Sector 9', 4);

  // One-off shifts inside the alert window (today .. today+3), whatever weekday the seed runs on.
  plans.push(
    { program: 'pantry', date: addDays(clock.today, 1), startTime: '11:00', durationMinutes: 180, location: 'Community Hall, Sector 14', headcount: 6, scenario: 'partial-alert' },
    { program: 'trail', date: addDays(clock.today, 2), startTime: '08:00', durationMinutes: 150, location: 'Damdama Lake, north bank', headcount: 5, scenario: 'open-alert' },
    { program: 'tutoring', date: addDays(clock.today, 2), startTime: '10:30', durationMinutes: 120, location: 'Public Library, Room 2', headcount: 3, scenario: 'refilled-after-dismissal' },
    { program: 'pantry', date: addDays(clock.today, 3), startTime: '10:00', durationMinutes: 120, location: 'Pantry Warehouse, Gate 2', headcount: 4, scenario: 'dismissed-alert' },
  );

  // An extra pantry restock that overlaps the first tutoring session after the alert window, where
  // Asha (the demo volunteer) is booked: trying to sign up for it shows the overlap rule.
  const tutoring = plans
    .filter((p) => p.program === 'tutoring' && p.date > addDays(clock.today, 3) && p.startTime === '16:00')
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  tutoring.bookAsha = true;
  plans.push({ program: 'pantry', date: tutoring.date, startTime: '16:30', durationMinutes: 120, location: 'Pantry Warehouse, Gate 2', headcount: 2, scenario: 'overlap-demo' });

  const sorted = plans.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  // The most recently finished shift is left unclosed, so a coordinator can demo Close.
  sorted
    .filter((p) => p.program !== 'monsoon' && local(p.date, p.startTime, p.durationMinutes) <= clock.now)
    .slice(-1)
    .forEach((p) => (p.scenario = 'needs-closing'));
  return sorted;
}

const NOTES = [
  'Great turnout today, everyone left on time.',
  'Ran short of gloves; please bring a pair next time.',
  'Two new families registered at the desk.',
  'Paths near the stream are muddy, wear proper shoes.',
  'Thanks all! Finished 30 minutes early.',
  'Projector in Room 2 was not working; used the whiteboard.',
];

// ---------------------------------------------------------------------------------------------
// Replaying history

interface Ctx {
  userIds: Map<string, number>;
  coordinatorIds: number[];
  /** Each volunteer's booked time windows, to keep the seed inside the overlap rule. */
  bookings: Map<number, [Local, Local][]>;
}

async function insertEvent(
  tx: PoolClient,
  e: { shiftId: number; type: string; actorId: number; at: Local; volunteerId?: number; from?: string; to?: string; note?: string; details?: object },
) {
  await tx.query(
    `INSERT INTO shift_events (shift_id, event_type, actor_id, volunteer_id, from_state, to_state, note, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${AT('$9')})`,
    [e.shiftId, e.type, e.actorId, e.volunteerId ?? null, e.from ?? null, e.to ?? null, e.note ?? null, e.details ? JSON.stringify(e.details) : null, e.at],
  );
}

/** One signup or cancellation, with its timeline entries, as a single transaction. */
async function changeSignup(
  shiftId: number,
  change: { kind: 'signup' | 'cancel'; volunteerId: number; actorId: number; at: Local; signupId?: number },
): Promise<number> {
  return withTransaction(async (tx) => {
    const before = (await tx.query<{ state: string }>('SELECT state FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0].state;
    let signupId = change.signupId ?? 0;
    if (change.kind === 'signup') {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO signups (shift_id, volunteer_id, time_range, created_by, created_at)
         SELECT id, $2, time_range, $3, ${AT('$4')} FROM shifts WHERE id = $1 RETURNING id`,
        [shiftId, change.volunteerId, change.actorId, change.at],
      );
      signupId = rows[0].id;
    } else {
      await tx.query(`UPDATE signups SET cancelled_at = ${AT('$2')}, cancelled_by = $3 WHERE id = $1`, [signupId, change.at, change.actorId]);
    }
    const after = (
      await tx.query<{ state: string }>('UPDATE shifts SET signup_count = signup_count + $2 WHERE id = $1 RETURNING state', [
        shiftId,
        change.kind === 'signup' ? 1 : -1,
      ])
    ).rows[0].state;
    await insertEvent(tx, {
      shiftId,
      type: change.kind === 'signup' ? 'signup_created' : 'signup_cancelled',
      actorId: change.actorId,
      volunteerId: change.volunteerId,
      at: change.at,
    });
    if (after !== before) {
      await insertEvent(tx, { shiftId, type: 'state_changed', actorId: change.actorId, from: before, to: after, at: change.at });
    }
    if (change.kind === 'cancel' && before === 'filled') {
      await tx.query('UPDATE shifts SET alert_dismissed_at = NULL, alert_dismissed_by = NULL WHERE id = $1', [shiftId]);
    }
    return signupId;
  });
}

function canBook(ctx: Ctx, volunteerId: number, start: Local, end: Local): boolean {
  return !(ctx.bookings.get(volunteerId) ?? []).some(([s, e]) => s < end && start < e);
}
function book(ctx: Ctx, volunteerId: number, start: Local, end: Local) {
  ctx.bookings.set(volunteerId, [...(ctx.bookings.get(volunteerId) ?? []), [start, end]]);
}
function unbook(ctx: Ctx, volunteerId: number, start: Local) {
  ctx.bookings.set(volunteerId, (ctx.bookings.get(volunteerId) ?? []).filter(([s]) => s !== start));
}

/** How full a shift ends up, by when it is. */
function targetFill(plan: ShiftPlan, start: Local, ended: boolean): number {
  if (plan.scenario === 'open-alert') return 0;
  if (plan.scenario === 'partial-alert') return 2;
  if (plan.scenario === 'refilled-after-dismissal') return plan.headcount;
  if (plan.scenario === 'dismissed-alert') return 1;
  if (plan.scenario === 'overlap-demo') return 0;
  const daysAhead = minutesBetween(clock.now, start) / (60 * 24);
  const share = ended ? 0.5 + random() * 0.5 : daysAhead < 10 ? 0.4 + random() * 0.6 : daysAhead < 21 ? 0.1 + random() * 0.5 : random() * 0.3;
  return Math.min(plan.headcount, Math.round(plan.headcount * share));
}

async function seedShift(ctx: Ctx, plan: ShiftPlan, programId: number, memberEmails: string[]) {
  const coordinator = pick(ctx.coordinatorIds);
  const start = local(plan.date, plan.startTime);
  const end = local(plan.date, plan.startTime, plan.durationMinutes);
  const ended = end <= clock.now;
  const seedStart = local(addDays(clock.today, -84), '09:00');
  // Shifts were scheduled about three weeks ahead (never in the future, never before the program existed).
  const createdAt = later(seedStart, earlier(local(addDays(plan.date, -21), '10:00'), local(addDays(clock.today, -1), '10:00')));

  const shiftId = await withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO shifts (program_id, shift_date, start_time, duration_minutes, location, required_headcount, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${AT('$8')}) RETURNING id`,
      [programId, plan.date, plan.startTime, plan.durationMinutes, plan.location, plan.headcount, coordinator, createdAt],
    );
    const isRecurring = !plan.scenario || plan.scenario === 'needs-closing';
    await insertEvent(tx, {
      shiftId: rows[0].id,
      type: 'created',
      actorId: coordinator,
      at: createdAt,
      details: isRecurring ? { source: 'recurring' } : undefined,
    });
    return rows[0].id;
  });

  // Signups happen between scheduling and an hour before the start (or now, for future shifts).
  const signupWindowEnd = earlier(local(plan.date, plan.startTime, -60), clock.now);
  const asha = ctx.userIds.get('volunteer@demo.org')!;
  let candidates = shuffled(memberEmails.map((email) => ctx.userIds.get(email)!));
  if (plan.bookAsha || plan.scenario === 'refilled-after-dismissal') candidates = [asha, ...candidates.filter((id) => id !== asha)];
  if (plan.scenario === 'dismissed-alert') candidates = candidates.filter((id) => id !== asha);

  // Decide everything that happens to this shift first, then apply it in time order, so the
  // timeline (ordered by insertion) reads chronologically and each recorded state change is real.
  type Action =
    | { at: Local; kind: 'signup'; volunteerId: number; actorId: number }
    | { at: Local; kind: 'cancel'; volunteerId: number }
    | { at: Local; kind: 'dismiss' };
  const actions: Action[] = [];
  const wanted = Math.max(targetFill(plan, start, ended), plan.bookAsha ? 1 : 0);
  const times = Array.from({ length: wanted }, () => between(createdAt, signupWindowEnd)).sort();

  if (plan.scenario === 'refilled-after-dismissal') {
    // One short and inside the alert window yesterday evening, a coordinator dismissed the alert;
    // the last spot was taken today. Cancelling any of its signups now brings the alert back.
    const dismissedAt = local(addDays(clock.today, -1), '18:00');
    times.splice(0, times.length, ...times.slice(0, -1).map((t) => earlier(t, local(addDays(clock.today, -1), '17:00'))));
    times.push(between(local(addDays(clock.today, -1), '18:30'), clock.now));
    actions.push({ at: dismissedAt, kind: 'dismiss' });
  }
  if (plan.scenario === 'dismissed-alert') actions.push({ at: clock.now, kind: 'dismiss' });

  const chosen: number[] = [];
  for (const at of times) {
    const volunteerId = candidates.find((id) => canBook(ctx, id, start, end) && !chosen.includes(id));
    if (volunteerId === undefined) break;
    chosen.push(volunteerId);
    book(ctx, volunteerId, start, end);
    // Now and then a coordinator signs someone up on their behalf.
    actions.push({ at, kind: 'signup', volunteerId, actorId: random() < 0.15 ? coordinator : volunteerId });
    // A few people cancel later on (never on the demo scenario shifts).
    if (!plan.scenario && !plan.bookAsha && random() < 0.08) {
      actions.push({ at: between(at, signupWindowEnd), kind: 'cancel', volunteerId });
      unbook(ctx, volunteerId, start);
    }
  }

  const signupIds = new Map<number, number>();
  for (const action of actions.sort((a, b) => a.at.localeCompare(b.at))) {
    if (action.kind === 'signup') {
      signupIds.set(action.volunteerId, await changeSignup(shiftId, action));
    } else if (action.kind === 'cancel') {
      const signupId = signupIds.get(action.volunteerId)!;
      await changeSignup(shiftId, { kind: 'cancel', volunteerId: action.volunteerId, actorId: action.volunteerId, at: action.at, signupId });
    } else {
      await withTransaction(async (tx) => {
        await tx.query(`UPDATE shifts SET alert_dismissed_at = ${AT('$2')}, alert_dismissed_by = $3 WHERE id = $1`, [shiftId, action.at, coordinator]);
        await insertEvent(tx, { shiftId, type: 'alert_dismissed', actorId: coordinator, at: action.at });
      });
    }
  }

  // Finished shifts are closed between an hour after they end and the next morning, sometimes with a note.
  if (ended && plan.scenario !== 'needs-closing') {
    const closedAt = earlier(
      between(local(plan.date, plan.startTime, plan.durationMinutes + 60), local(addDays(plan.date, 1), '11:00')),
      clock.now,
    );
    await withTransaction(async (tx) => {
      const before = (await tx.query<{ state: string }>('SELECT state FROM shifts WHERE id = $1', [shiftId])).rows[0].state;
      await tx.query(`UPDATE shifts SET closed_at = ${AT('$2')}, closed_by = $3 WHERE id = $1`, [shiftId, closedAt, coordinator]);
      await insertEvent(tx, { shiftId, type: 'state_changed', actorId: coordinator, from: before, to: 'closed', at: closedAt });
      if (random() < 0.25) await insertEvent(tx, { shiftId, type: 'note', actorId: coordinator, note: pick(NOTES), at: closedAt });
    });
  }
}

async function main() {
  const host = new URL(config.DATABASE_URL).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (!isLocal && !process.argv.includes('--yes-wipe-remote')) {
    console.error(`This wipes every table in the database at ${host}. Re-run with --yes-wipe-remote if you mean it.`);
    process.exit(1);
  }

  // TRUNCATE is blocked on the history table, so a reset rebuilds the schema from the migrations.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);

  const ctx: Ctx = { userIds: new Map(), coordinatorIds: [], bookings: new Map() };
  const created = local(addDays(clock.today, -90), '09:00');
  const coordinatorHash = await hashPassword(DEMO_PASSWORDS.coordinator);
  const volunteerHash = await hashPassword(DEMO_PASSWORDS.volunteer);
  for (const [people, role, hash] of [
    [COORDINATORS, 'coordinator', coordinatorHash],
    [VOLUNTEERS, 'volunteer', volunteerHash],
  ] as const) {
    for (const person of people) {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO users (email, name, password_hash, role, created_at) VALUES ($1, $2, $3, $4, ${AT('$5')}) RETURNING id`,
        [person.email, person.name, hash, role, created],
      );
      ctx.userIds.set(person.email, rows[0].id);
      if (role === 'coordinator') ctx.coordinatorIds.push(rows[0].id);
    }
  }

  const programIds = new Map<string, number>();
  for (const program of PROGRAMS) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO programs (name, description, created_by, created_at) VALUES ($1, $2, $3, ${AT('$4')}) RETURNING id`,
      [program.name, program.description, ctx.coordinatorIds[0], created],
    );
    programIds.set(program.key, rows[0].id);
    for (const email of program.members) {
      await pool.query(`INSERT INTO program_members (program_id, user_id, added_by, added_at) VALUES ($1, $2, $3, ${AT('$4')})`, [
        rows[0].id,
        ctx.userIds.get(email),
        ctx.coordinatorIds[0],
        created,
      ]);
    }
  }

  const plans = planShifts();
  for (const plan of plans) {
    const program = PROGRAMS.find((p) => p.key === plan.program)!;
    await seedShift(ctx, plan, programIds.get(plan.program)!, program.members);
  }

  for (const program of PROGRAMS.filter((p) => p.archivedWeeksAgo)) {
    await pool.query(`UPDATE programs SET archived_at = ${AT('$2')} WHERE id = $1`, [
      programIds.get(program.key),
      local(addDays(clock.today, -7 * program.archivedWeeksAgo!), '12:00'),
    ]);
  }

  const { rows } = await pool.query<{ shifts: number; signups: number; events: number }>(
    `SELECT (SELECT count(*) FROM shifts) AS shifts, (SELECT count(*) FROM signups) AS signups, (SELECT count(*) FROM shift_events) AS events`,
  );
  console.log(`Seeded ${rows[0].shifts} shifts, ${rows[0].signups} signups and ${rows[0].events} history entries (today is ${clock.today} in ${TZ}).`);
  console.log(`Coordinator: coordinator@demo.org / ${DEMO_PASSWORDS.coordinator}`);
  console.log(`Volunteer:   volunteer@demo.org / ${DEMO_PASSWORDS.volunteer}  (other volunteers use the same password)`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
