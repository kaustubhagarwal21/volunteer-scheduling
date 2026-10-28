import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/types';
import type { DashboardResponse } from '../src/dashboard/service';
import { pool } from '../src/db/pool';
import { addDays, orgClock } from '../src/time/orgClock';
import {
  addMember,
  app,
  createProgram,
  createUser,
  dayFromToday,
  insertShift,
  insertSignup,
  signIn,
  unique,
  type Agent,
} from './helpers';

/*
 * Goal 8: the dashboard. "This week" runs Monday to Sunday in the organisation's time zone, which
 * the test environment pins to Asia/Kolkata (UTC+05:30, no daylight saving).
 *
 * Every test file shares one database, so most tests read the dashboard of a brand-new volunteer
 * who is the only member of a brand-new program: that dashboard sees our program and nothing else.
 */

const ZERO_COUNTS = { open: 0, partially_filled: 0, filled: 0, closed: 0 };

/** 'YYYY-MM-DD' for this week's Monday plus `days` (negative for earlier weeks). */
function mondayPlus(days: number): string {
  return addDays(orgClock().weekStart, days);
}

/** A new program whose only member is a new volunteer, plus that volunteer signed in as the viewer. */
async function isolatedProgram() {
  const coordinator = await createUser('coordinator');
  const program = await createProgram(coordinator);
  const volunteer = await createUser('volunteer');
  await addMember(program.id, volunteer, coordinator);
  return { coordinator, program, volunteer, viewer: await signIn(volunteer) };
}

async function getDashboard(agent: Agent): Promise<DashboardResponse> {
  const res = await agent.get('/api/dashboard');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/**
 * An active signup backdated to an organisation-local wall-clock time ('YYYY-MM-DD HH:MM').
 * The insert and the count change are one statement, so they pass the commit-time count check.
 */
async function insertSignupMadeAt(shiftId: number, volunteer: AuthUser, orgLocalTime: string): Promise<void> {
  await pool.query(
    `WITH new_signup AS (
       INSERT INTO signups (shift_id, volunteer_id, time_range, created_by, created_at)
       SELECT id, $2, time_range, $2, $3::timestamp AT TIME ZONE $4 FROM shifts WHERE id = $1
       RETURNING id
     ), bump AS (
       UPDATE shifts SET signup_count = signup_count + 1 WHERE id = $1
     )
     SELECT id FROM new_signup`,
    [shiftId, volunteer.id, orgLocalTime, orgClock().timeZone],
  );
}

/** Closes a shift as of an organisation-local wall-clock time, to backdate the closure. */
async function closeShiftAt(shiftId: number, coordinator: AuthUser, orgLocalTime: string): Promise<void> {
  await pool.query('UPDATE shifts SET closed_at = $3::timestamp AT TIME ZONE $4, closed_by = $2 WHERE id = $1', [
    shiftId,
    coordinator.id,
    orgLocalTime,
    orgClock().timeZone,
  ]);
}

/** The app's soft delete, done directly because the API refuses to delete a shift that has started. */
async function softDeleteShift(shiftId: number, coordinator: AuthUser): Promise<void> {
  await pool.query('UPDATE shifts SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [shiftId, coordinator.id]);
}

describe('dashboard headline numbers for this week', () => {
  it('covers this Monday to this Sunday', async () => {
    const { viewer } = await isolatedProgram();
    const { weekStart, weekEnd } = await getDashboard(viewer);
    expect(weekStart).toBe(orgClock().weekStart);
    expect(new Date(`${weekStart}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
    expect(weekEnd).toBe(mondayPlus(6));
  });

  it('counts the shifts dated Monday to Sunday this week in any state, but not deleted ones', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const monday = await insertShift(program.id, coordinator, { date: mondayPlus(0) });
    await closeShiftAt(monday, coordinator, `${mondayPlus(0)} 12:30`);
    const thursday = await insertShift(program.id, coordinator, { date: mondayPlus(3), requiredHeadcount: 1 });
    await insertSignup(thursday, volunteer); // Filled
    await insertShift(program.id, coordinator, { date: mondayPlus(6) }); // Sunday, Open
    const deleted = await insertShift(program.id, coordinator, { date: mondayPlus(4) });
    await softDeleteShift(deleted, coordinator);
    await insertShift(program.id, coordinator, { date: mondayPlus(-1) }); // last Sunday
    await insertShift(program.id, coordinator, { date: mondayPlus(7) }); // next Monday

    const { headline } = await getDashboard(viewer);
    expect(headline.shiftsThisWeek).toBe(3);
  });

  it('counts as open only the shifts this week that have no signups yet', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    await insertShift(program.id, coordinator, { date: mondayPlus(1) });
    await insertShift(program.id, coordinator, { date: mondayPlus(5) });
    const partial = await insertShift(program.id, coordinator, { date: mondayPlus(2), requiredHeadcount: 2 });
    await insertSignup(partial, volunteer);
    const filled = await insertShift(program.id, coordinator, { date: mondayPlus(4), requiredHeadcount: 1 });
    await insertSignup(filled, volunteer);
    await insertShift(program.id, coordinator, { date: mondayPlus(-2) }); // Open, but last week
    await insertShift(program.id, coordinator, { date: mondayPlus(9) }); // Open, but next week

    const { headline } = await getDashboard(viewer);
    expect(headline).toMatchObject({ shiftsThisWeek: 4, openShiftsThisWeek: 2, partiallyFilledThisWeek: 1 });
  });

  it('counts every signup made this week, by a volunteer or a coordinator, including one cancelled since', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const coord = await signIn(coordinator);
    const kept = await insertShift(program.id, coordinator, { date: dayFromToday(10) });
    const dropped = await insertShift(program.id, coordinator, { date: dayFromToday(11) });
    const byCoordinator = await insertShift(program.id, coordinator, { date: dayFromToday(12) });

    expect((await viewer.post(`/api/shifts/${kept}/signups`)).status).toBe(201);
    const later = await viewer.post(`/api/shifts/${dropped}/signups`);
    expect(later.status).toBe(201);
    expect((await viewer.post(`/api/signups/${later.body.signup.id}/cancel`)).status).toBe(204);
    const onTheirBehalf = await coord.post(`/api/shifts/${byCoordinator}/signups`).send({ volunteerId: volunteer.id });
    expect(onTheirBehalf.status).toBe(201);

    const { headline } = await getDashboard(viewer);
    expect(headline.signupsThisWeek).toBe(3);
  });

  it('counts a signup in the week it was made, not the week of its shift', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const thisWeeksShift = await insertShift(program.id, coordinator, { date: mondayPlus(3) });
    await insertSignupMadeAt(thisWeeksShift, volunteer, `${mondayPlus(-4)} 12:00`); // made last Thursday
    const nextMonthsShift = await insertShift(program.id, coordinator, { date: dayFromToday(30) });
    expect((await viewer.post(`/api/shifts/${nextMonthsShift}/signups`)).status).toBe(201); // made now

    const { headline } = await getDashboard(viewer);
    expect(headline.signupsThisWeek).toBe(1);
  });

  it('counts the shifts closed this week, even one dated last week, but not one closed last week', async () => {
    const { coordinator, program, viewer } = await isolatedProgram();
    const coord = await signIn(coordinator);
    const lastFriday = await insertShift(program.id, coordinator, { date: mondayPlus(-3) });
    expect((await coord.post(`/api/shifts/${lastFriday}/close`)).status).toBe(200); // closed now, so this week
    const closedEarlier = await insertShift(program.id, coordinator, { date: mondayPlus(-10) });
    await closeShiftAt(closedEarlier, coordinator, `${mondayPlus(-5)} 18:00`); // closed last Wednesday
    await insertShift(program.id, coordinator, { date: mondayPlus(-4) }); // over, but nobody closed it

    const { headline } = await getDashboard(viewer);
    expect(headline.closedThisWeek).toBe(1);
  });

  it('starts the week at midnight on Monday in the org time zone, not at midnight UTC', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const sundayNight = `${mondayPlus(-1)} 23:30`; // last week
    const mondayEarly = `${mondayPlus(0)} 00:30`; // this week, though still 19:00 on Sunday in UTC
    const signedUpSundayNight = await insertShift(program.id, coordinator, { date: dayFromToday(20) });
    const signedUpMondayEarly = await insertShift(program.id, coordinator, { date: dayFromToday(21) });
    await insertSignupMadeAt(signedUpSundayNight, volunteer, sundayNight);
    await insertSignupMadeAt(signedUpMondayEarly, volunteer, mondayEarly);
    const closedSundayNight = await insertShift(program.id, coordinator, { date: mondayPlus(-4) });
    const closedMondayEarly = await insertShift(program.id, coordinator, { date: mondayPlus(-3) });
    await closeShiftAt(closedSundayNight, coordinator, sundayNight);
    await closeShiftAt(closedMondayEarly, coordinator, mondayEarly);

    const { headline } = await getDashboard(viewer);
    expect(headline.signupsThisWeek).toBe(1);
    expect(headline.closedThisWeek).toBe(1);
  });
});

describe('dashboard breakdown of all live shifts', () => {
  it('counts every live shift by fill state, whatever its date', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const coord = await signIn(coordinator);
    await insertShift(program.id, coordinator, { date: dayFromToday(40) });
    await insertShift(program.id, coordinator, { date: dayFromToday(-40) }); // over but never closed: still Open
    const partial = await insertShift(program.id, coordinator, { date: dayFromToday(41), requiredHeadcount: 3 });
    await insertSignup(partial, volunteer);
    const filled = await insertShift(program.id, coordinator, { date: dayFromToday(42), requiredHeadcount: 1 });
    await insertSignup(filled, volunteer);
    const closed = await insertShift(program.id, coordinator, { date: dayFromToday(-30) });
    expect((await coord.post(`/api/shifts/${closed}/close`)).status).toBe(200);

    const { byState } = await getDashboard(viewer);
    expect(byState).toEqual({ open: 2, partially_filled: 1, filled: 1, closed: 1 });
  });

  it("counts each program's shifts by fill state with a total, listing a program with no shifts as zeros", async () => {
    const coordinator = await createUser('coordinator');
    const volunteer = await createUser('volunteer');
    const pantry = await createProgram(coordinator, `Food Pantry ${unique()}`);
    const trail = await createProgram(coordinator, `Trail Cleanup ${unique()}`);
    const tutoring = await createProgram(coordinator, `Tutoring ${unique()}`);
    for (const program of [pantry, trail, tutoring]) await addMember(program.id, volunteer, coordinator);
    await insertShift(pantry.id, coordinator, { date: dayFromToday(5) });
    await insertShift(pantry.id, coordinator, { date: dayFromToday(6) });
    const pantryPartial = await insertShift(pantry.id, coordinator, { date: dayFromToday(7), requiredHeadcount: 2 });
    await insertSignup(pantryPartial, volunteer);
    const trailFilled = await insertShift(trail.id, coordinator, { date: dayFromToday(8), requiredHeadcount: 1 });
    await insertSignup(trailFilled, volunteer);

    const { byProgram } = await getDashboard(await signIn(volunteer));
    expect(byProgram).toHaveLength(3);
    expect(byProgram).toEqual(
      expect.arrayContaining([
        { programId: pantry.id, name: pantry.name, total: 3, ...ZERO_COUNTS, open: 2, partially_filled: 1 },
        { programId: trail.id, name: trail.name, total: 1, ...ZERO_COUNTS, filled: 1 },
        { programId: tutoring.id, name: tutoring.name, total: 0, ...ZERO_COUNTS },
      ]),
    );
  });

  it('drops a deleted shift from the breakdowns, but still counts the signup made on it', async () => {
    const { coordinator, program, viewer } = await isolatedProgram();
    const coord = await signIn(coordinator);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(9) });
    expect((await viewer.post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);
    expect((await coord.delete(`/api/shifts/${shiftId}`)).status).toBe(200);

    const { byState, byProgram, headline } = await getDashboard(viewer);
    expect(byState).toEqual(ZERO_COUNTS);
    expect(byProgram).toEqual([{ programId: program.id, name: program.name, total: 0, ...ZERO_COUNTS }]);
    expect(headline.signupsThisWeek).toBe(1);
  });

  it('leaves out an archived program, for its volunteers and for coordinators', async () => {
    const { coordinator, program, viewer } = await isolatedProgram();
    const coord = await signIn(coordinator);
    await insertShift(program.id, coordinator, { date: mondayPlus(2) });
    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);

    const forVolunteer = await getDashboard(viewer);
    expect(forVolunteer.byProgram).toEqual([]);
    expect(forVolunteer.byState).toEqual(ZERO_COUNTS);
    expect(forVolunteer.headline.shiftsThisWeek).toBe(0);
    const forCoordinator = await getDashboard(coord);
    expect(forCoordinator.byProgram.map((p) => p.programId)).not.toContain(program.id);
  });
});

describe('dashboard chart of signups per week', () => {
  it('has exactly eight weeks, oldest first, the last one starting this Monday', async () => {
    const { viewer } = await isolatedProgram();
    const { signupsPerWeek } = await getDashboard(viewer);
    expect(signupsPerWeek.map((week) => week.weekStart)).toEqual([-49, -42, -35, -28, -21, -14, -7, 0].map(mondayPlus));
    expect(signupsPerWeek.at(-1)?.weekStart).toBe(orgClock().weekStart);
  });

  it('puts a signup made three weeks ago in that week, and zero in every week without signups', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const shiftId = await insertShift(program.id, coordinator, { date: mondayPlus(-16) });
    await insertSignupMadeAt(shiftId, volunteer, `${mondayPlus(-19)} 15:00`); // Wednesday, three weeks ago

    const { signupsPerWeek } = await getDashboard(viewer);
    expect(signupsPerWeek.map((week) => week.signups)).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(signupsPerWeek[4]).toEqual({ weekStart: mondayPlus(-21), signups: 1 });
  });

  it('counts each signup in the week it was made, cancelled ones included, and nothing older than eight weeks', async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const nineWeeksAgo = await insertShift(program.id, coordinator, { date: mondayPlus(-60) });
    await insertSignupMadeAt(nineWeeksAgo, volunteer, `${mondayPlus(-63)} 12:00`); // before the chart starts
    const sevenWeeksAgo = await insertShift(program.id, coordinator, { date: mondayPlus(-45) });
    await insertSignupMadeAt(sevenWeeksAgo, volunteer, `${mondayPlus(-49)} 12:00`); // the oldest week shown
    const twoWeeksAgo = await insertShift(program.id, coordinator, { date: mondayPlus(-10) });
    await insertSignupMadeAt(twoWeeksAgo, volunteer, `${mondayPlus(-12)} 12:00`);
    const alsoTwoWeeksAgo = await insertShift(program.id, coordinator, { date: mondayPlus(-8) });
    await insertSignupMadeAt(alsoTwoWeeksAgo, volunteer, `${mondayPlus(-9)} 12:00`);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(14) });
    const signup = await viewer.post(`/api/shifts/${upcoming}/signups`); // made this week...
    expect(signup.status).toBe(201);
    expect((await viewer.post(`/api/signups/${signup.body.signup.id}/cancel`)).status).toBe(204); // ...and cancelled

    const { signupsPerWeek } = await getDashboard(viewer);
    expect(signupsPerWeek.map((week) => week.signups)).toEqual([1, 0, 0, 0, 0, 2, 0, 1]);
  });

  it("buckets by the org's week: a signup made at 9 a.m. on a Monday belongs to that Monday's week", async () => {
    // In Kolkata (UTC+05:30), 23:30 on Sunday is 18:00 UTC and 09:00 on Monday is 03:30 UTC.
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const signedUpSundayNight = await insertShift(program.id, coordinator, { date: mondayPlus(-20) });
    await insertSignupMadeAt(signedUpSundayNight, volunteer, `${mondayPlus(-22)} 23:30`); // four weeks ago
    const signedUpMondayMorning = await insertShift(program.id, coordinator, { date: mondayPlus(-19) });
    await insertSignupMadeAt(signedUpMondayMorning, volunteer, `${mondayPlus(-21)} 09:00`); // three weeks ago

    const { signupsPerWeek } = await getDashboard(viewer);
    expect(signupsPerWeek.map((week) => week.signups)).toEqual([0, 0, 0, 1, 1, 0, 0, 0]);
  });

  it("agrees with the headline: this week's bar is the number of signups made this week", async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const signedUpMondayMorning = await insertShift(program.id, coordinator, { date: dayFromToday(16) });
    await insertSignupMadeAt(signedUpMondayMorning, volunteer, `${mondayPlus(0)} 09:00`);
    const signedUpNow = await insertShift(program.id, coordinator, { date: dayFromToday(17) });
    expect((await viewer.post(`/api/shifts/${signedUpNow}/signups`)).status).toBe(201);

    const { headline, signupsPerWeek } = await getDashboard(viewer);
    expect(headline.signupsThisWeek).toBe(2);
    expect(signupsPerWeek.at(-1)).toEqual({ weekStart: mondayPlus(0), signups: 2 });
  });
});

describe('dashboard scope', () => {
  it('requires a signed-in user', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
  });

  it('shows a volunteer who belongs to no program zeros, no programs and eight empty weeks', async () => {
    const volunteer = await createUser('volunteer');
    const body = await getDashboard(await signIn(volunteer));
    expect(body.headline).toEqual({
      shiftsThisWeek: 0,
      openShiftsThisWeek: 0,
      partiallyFilledThisWeek: 0,
      signupsThisWeek: 0,
      closedThisWeek: 0,
    });
    expect(body.byState).toEqual(ZERO_COUNTS);
    expect(body.byProgram).toEqual([]);
    expect(body.signupsPerWeek.map((week) => week.signups)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("counts only a volunteer's own programs, never shifts or signups in programs they don't belong to", async () => {
    const { coordinator, program, volunteer, viewer } = await isolatedProgram();
    const mine = await insertShift(program.id, coordinator, { date: mondayPlus(2), requiredHeadcount: 3 });
    await insertSignup(mine, volunteer);
    const elsewhere = await createProgram(coordinator);
    const stranger = await createUser('volunteer');
    await addMember(elsewhere.id, stranger, coordinator);
    const theirs = await insertShift(elsewhere.id, coordinator, { date: mondayPlus(2), requiredHeadcount: 1 });
    await insertSignup(theirs, stranger);
    await insertShift(elsewhere.id, coordinator, { date: mondayPlus(3) });

    const body = await getDashboard(viewer);
    expect(body.byProgram.map((p) => p.programId)).toEqual([program.id]);
    expect(body.byState).toEqual({ ...ZERO_COUNTS, partially_filled: 1 });
    expect(body.headline).toMatchObject({ shiftsThisWeek: 1, openShiftsThisWeek: 0, signupsThisWeek: 1 });
  });

  it("includes every active program in a coordinator's dashboard, with that program's own numbers", async () => {
    const { coordinator, program, volunteer } = await isolatedProgram();
    // A coordinator who did not create the program: coordinators see every program.
    const coord = await signIn(await createUser('coordinator'));
    const before = await getDashboard(coord);
    expect(before.byProgram).toContainEqual({ programId: program.id, name: program.name, total: 0, ...ZERO_COUNTS });

    await insertShift(program.id, coordinator, { date: mondayPlus(1) });
    const partial = await insertShift(program.id, coordinator, { date: dayFromToday(15), requiredHeadcount: 2 });
    await insertSignup(partial, volunteer);

    const after = await getDashboard(coord);
    expect(after.byProgram).toContainEqual({
      programId: program.id,
      name: program.name,
      total: 2,
      ...ZERO_COUNTS,
      open: 1,
      partially_filled: 1,
    });
    // A coordinator also sees every other test's programs, so compare the overall numbers as changes.
    expect(after.byState.open - before.byState.open).toBe(1);
    expect(after.byState.partially_filled - before.byState.partially_filled).toBe(1);
    expect(after.headline.shiftsThisWeek - before.headline.shiftsThisWeek).toBe(1);
    expect(after.headline.signupsThisWeek - before.headline.signupsThisWeek).toBe(1);
  });
});
