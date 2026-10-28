import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AlertsResponse } from '../src/alerts/service';
import type { TimelineEntry } from '../src/shifts/service';
import { orgClock } from '../src/time/orgClock';
import {
  addMember,
  app,
  createProgram,
  createUser,
  dayFromToday,
  eventsFor,
  insertShift,
  insertSignup,
  setupProgram,
  signIn,
  type Agent,
} from './helpers';

/** GET /api/alerts as `agent`. The badge number must always equal the length of the active list. */
async function alertsFor(agent: Agent): Promise<AlertsResponse> {
  const res = await agent.get('/api/alerts');
  expect(res.status).toBe(200);
  expect(res.body.count).toBe(res.body.alerts.length);
  return res.body;
}

/**
 * Which of `shiftIds` are in the viewer's active and dismissed lists, in the server's order.
 * Other tests raise alerts too, so a coordinator's view is always narrowed to the test's own shifts.
 */
async function alertIdsAmong(agent: Agent, shiftIds: number[]): Promise<{ alerts: number[]; dismissed: number[] }> {
  const { alerts, dismissed } = await alertsFor(agent);
  const ours = (list: { id: number }[]) => list.map((shift) => shift.id).filter((id) => shiftIds.includes(id));
  return { alerts: ours(alerts), dismissed: ours(dismissed) };
}

const dismiss = (agent: Agent, shiftId: number) => agent.post(`/api/alerts/${shiftId}/dismiss`);

async function timelineOf(agent: Agent, shiftId: number): Promise<TimelineEntry[]> {
  const res = await agent.get(`/api/shifts/${shiftId}/timeline`);
  expect(res.status).toBe(200);
  return res.body.events;
}

/** 'HH:MM' at least half an hour from now and still today (organisation time), or null late at night. */
function laterToday(): string | null {
  const now = orgClock().now; // 'YYYY-MM-DD HH:MM:SS'
  const minutes = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16)) + 30;
  if (minutes >= 24 * 60) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

describe('which shifts count as understaffed', () => {
  it('lists Open and Partially Filled shifts dated within the next three days, with a matching count', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const open = await insertShift(program.id, coordinator, { date: dayFromToday(1), requiredHeadcount: 2 });
    // The window is by date, so a shift late on the third day still counts.
    const partial = await insertShift(program.id, coordinator, {
      date: dayFromToday(3),
      startTime: '23:00',
      requiredHeadcount: 2,
    });
    await insertSignup(partial, volunteers[0]);

    // The member belongs only to this program, so their badge counts exactly these shifts.
    const view = await alertsFor(vols[0]);
    expect(view.count).toBe(2);
    expect(view.alerts).toMatchObject([
      { id: open, state: 'open', spotsLeft: 2, programId: program.id, programName: program.name, date: dayFromToday(1) },
      { id: partial, state: 'partially_filled', spotsLeft: 1, date: dayFromToday(3), startTime: '23:00' },
    ]);
    expect((await alertIdsAmong(coord, [open, partial])).alerts).toEqual([open, partial]);
  });

  it('lists a shift later today that has not started yet', async (ctx) => {
    const startTime = laterToday();
    if (!startTime) return ctx.skip('too close to midnight (organisation time) to schedule a shift later today');
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(0), startTime, durationMinutes: 15 });

    expect((await alertIdsAmong(coord, [shiftId])).alerts).toEqual([shiftId]);
  });

  it('leaves out shifts that are Filled, already under way, deleted, or four days away', async () => {
    const { coordinator, program, volunteers, coord } = await setupProgram(1);
    const understaffed = await insertShift(program.id, coordinator, { date: dayFromToday(2) });
    const filled = await insertShift(program.id, coordinator, { date: dayFromToday(1), requiredHeadcount: 1 });
    await insertSignup(filled, volunteers[0]);
    // Started at midnight and runs all day: still short, but too late for anyone to sign up.
    const underway = await insertShift(program.id, coordinator, {
      date: dayFromToday(0),
      startTime: '00:00',
      durationMinutes: 1440,
    });
    const deleted = await insertShift(program.id, coordinator, { date: dayFromToday(2), startTime: '14:00' });
    expect((await coord.delete(`/api/shifts/${deleted}`)).status).toBe(200);
    const fourDaysAway = await insertShift(program.id, coordinator, { date: dayFromToday(4), startTime: '00:00' });

    expect(await alertIdsAmong(coord, [understaffed, filled, underway, deleted, fourDaysAway])).toEqual({
      alerts: [understaffed],
      dismissed: [],
    });
  });

  it('leaves out a shift from earlier today that has ended and been closed', async (ctx) => {
    if (orgClock().now < `${dayFromToday(0)} 00:16:00`) return ctx.skip('nothing scheduled today can have ended yet');
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, {
      date: dayFromToday(0),
      startTime: '00:00',
      durationMinutes: 15,
    });
    const closed = await coord.post(`/api/shifts/${shiftId}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.shift.state).toBe('closed');

    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [], dismissed: [] });
  });

  it('leaves out shifts in archived programs', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1) });
    expect((await alertIdsAmong(coord, [shiftId])).alerts).toEqual([shiftId]);

    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);
    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [], dismissed: [] });
  });
});

describe('who sees alerts', () => {
  it('requires a signed-in user', async () => {
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('shows a volunteer only the alerts in programs they belong to', async () => {
    const { coordinator, program, volunteers, vols } = await setupProgram(1);
    const otherProgram = await createProgram(coordinator);
    const inTheirProgram = await insertShift(program.id, coordinator, { date: dayFromToday(1) });
    const inOtherProgram = await insertShift(otherProgram.id, coordinator, { date: dayFromToday(1) });

    const view = await alertsFor(vols[0]);
    expect(view.count).toBe(1);
    expect(view.alerts.map((shift) => shift.id)).toEqual([inTheirProgram]);

    // Joining the other program brings its alert into view.
    await addMember(otherProgram.id, volunteers[0], coordinator);
    expect((await alertsFor(vols[0])).alerts.map((shift) => shift.id)).toEqual([inTheirProgram, inOtherProgram]);
  });
});

describe('dismissing an alert', () => {
  it('removes it from the list and the badge for everyone; coordinators see it under dismissed, and the timeline records who', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(1);
    const toDismiss = await insertShift(program.id, coordinator, { date: dayFromToday(1) });
    const stillShort = await insertShift(program.id, coordinator, { date: dayFromToday(2) });
    const coordinatorCountBefore = (await alertsFor(coord)).count;
    expect((await alertsFor(vols[0])).count).toBe(2);

    const res = await dismiss(coord, toDismiss);
    expect(res.status).toBe(204);

    const memberView = await alertsFor(vols[0]);
    expect(memberView.count).toBe(1);
    expect(memberView.alerts.map((shift) => shift.id)).toEqual([stillShort]);
    expect(memberView.dismissed).toEqual([]); // the dismissed list is for coordinators only

    expect((await alertsFor(coord)).count).toBe(coordinatorCountBefore - 1);
    expect(await alertIdsAmong(coord, [toDismiss, stillShort])).toEqual({ alerts: [stillShort], dismissed: [toDismiss] });
    // The dismissal is shared: another coordinator sees it dismissed too.
    const colleague = await signIn(await createUser('coordinator'));
    expect(await alertIdsAmong(colleague, [toDismiss, stillShort])).toEqual({
      alerts: [stillShort],
      dismissed: [toDismiss],
    });

    expect((await timelineOf(coord, toDismiss)).at(-1)).toMatchObject({
      type: 'alert_dismissed',
      actor: { id: coordinator.id, name: coordinator.name, role: 'coordinator' },
    });
  });

  it('is refused for volunteers, and the alert stays', async () => {
    const { coordinator, program, vols } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1) });

    const res = await dismiss(vols[0], shiftId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/only coordinators/i);
    expect((await alertsFor(vols[0])).alerts.map((shift) => shift.id)).toEqual([shiftId]);
  });

  it('is refused with NO_ACTIVE_ALERT for a shift that has no active alert', async () => {
    const { coordinator, program, volunteers, coord } = await setupProgram(1);
    const filled = await insertShift(program.id, coordinator, { date: dayFromToday(1), requiredHeadcount: 1 });
    await insertSignup(filled, volunteers[0]);
    const underway = await insertShift(program.id, coordinator, { date: dayFromToday(0), startTime: '00:00' });
    const notYetInWindow = await insertShift(program.id, coordinator, { date: dayFromToday(4) });
    const alreadyDismissed = await insertShift(program.id, coordinator, { date: dayFromToday(2) });
    expect((await dismiss(coord, alreadyDismissed)).status).toBe(204);

    // Each refusal says why there is nothing to dismiss.
    const cases: [number, RegExp][] = [
      [filled, /is filled/],
      [underway, /already started/],
      [notYetInWindow, /only cover shifts in the next 3 days/],
      [alreadyDismissed, /already been dismissed/],
    ];
    for (const [shiftId, reason] of cases) {
      const res = await dismiss(coord, shiftId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NO_ACTIVE_ALERT');
      expect(res.body.error.message).toMatch(reason);
    }
    // Only the one real dismissal reached a timeline.
    for (const shiftId of [filled, underway, notYetInWindow]) {
      expect((await eventsFor(shiftId)).map((e) => e.event_type)).not.toContain('alert_dismissed');
    }
    expect((await eventsFor(alreadyDismissed)).filter((e) => e.event_type === 'alert_dismissed')).toHaveLength(1);
  });

  it('lets only one of two coordinators dismissing at the same moment succeed, and records one dismissal', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const colleague = await signIn(await createUser('coordinator'));
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1) });

    const results = await Promise.all([dismiss(coord, shiftId), dismiss(colleague, shiftId)]);
    expect(results.map((res) => res.status).sort()).toEqual([204, 409]);
    expect((await eventsFor(shiftId)).filter((e) => e.event_type === 'alert_dismissed')).toHaveLength(1);
  });

  it('answers 404 for a shift that does not exist or has been deleted', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const deleted = await insertShift(program.id, coordinator, { date: dayFromToday(1) });
    expect((await coord.delete(`/api/shifts/${deleted}`)).status).toBe(200);

    for (const shiftId of [deleted, 2_147_483_647]) {
      const res = await dismiss(coord, shiftId);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('when a dismissed alert comes back', () => {
  it('returns when a cancellation drops the Filled shift back to Partially Filled, and the timeline shows why', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(2), requiredHeadcount: 2 });
    const firstSignup = await vols[0].post(`/api/shifts/${shiftId}/signups`);
    expect(firstSignup.status).toBe(201);

    expect((await dismiss(coord, shiftId)).status).toBe(204);
    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [], dismissed: [shiftId] });

    // Filled: not understaffed any more, so it is in neither list.
    expect((await vols[1].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);
    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [], dismissed: [] });

    expect((await vols[0].post(`/api/signups/${firstSignup.body.signup.id}/cancel`)).status).toBe(204);
    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [shiftId], dismissed: [] });
    expect((await alertsFor(vols[1])).alerts.map((shift) => shift.id)).toEqual([shiftId]);

    const events = await timelineOf(coord, shiftId);
    expect(events.map((e) => e.type)).toEqual([
      'created',
      'signup_created',
      'state_changed',
      'alert_dismissed',
      'signup_created',
      'state_changed',
      'signup_cancelled',
      'state_changed',
    ]);
    expect(events[3]).toMatchObject({ type: 'alert_dismissed', actor: { id: coordinator.id } });
    expect(events.slice(-2)).toMatchObject([
      { type: 'signup_cancelled', actor: { id: volunteers[0].id }, volunteer: { id: volunteers[0].id } },
      { type: 'state_changed', fromState: 'filled', toState: 'partially_filled' },
    ]);
  });

  it('returns when a coordinator cancels the only signup of a Filled shift, back to Open', async () => {
    const { coordinator, program, volunteers, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1), requiredHeadcount: 1 });
    expect((await dismiss(coord, shiftId)).status).toBe(204);

    const signup = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[0].id });
    expect(signup.status).toBe(201);
    expect((await coord.post(`/api/signups/${signup.body.signup.id}/cancel`)).status).toBe(204);

    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [shiftId], dismissed: [] });
    expect((await timelineOf(coord, shiftId)).at(-1)).toMatchObject({ fromState: 'filled', toState: 'open' });
  });

  it('can be dismissed again after it returns, and returns again on the next cancellation out of Filled', async () => {
    const { coordinator, program, volunteers, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1), requiredHeadcount: 1 });

    for (let round = 1; round <= 2; round += 1) {
      expect((await dismiss(coord, shiftId)).status).toBe(204);
      const signup = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[0].id });
      expect(signup.status).toBe(201);
      expect((await coord.post(`/api/signups/${signup.body.signup.id}/cancel`)).status).toBe(204);
      expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [shiftId], dismissed: [] });
    }
    expect((await eventsFor(shiftId)).filter((e) => e.event_type === 'alert_dismissed')).toHaveLength(2);
  });

  it('returns when removing a volunteer from the program cancels their signup on a Filled shift', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(2), requiredHeadcount: 1 });
    expect((await dismiss(coord, shiftId)).status).toBe(204);
    expect((await vols[0].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);

    const removed = await coord.delete(`/api/programs/${program.id}/members/${volunteers[0].id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.cancelledSignups).toBe(1);

    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [shiftId], dismissed: [] });
  });

  it('stays dismissed when a headcount increase, not a cancellation, takes the shift out of Filled', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(2), requiredHeadcount: 2 });
    expect((await vols[0].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);
    expect((await dismiss(coord, shiftId)).status).toBe(204);
    expect((await vols[1].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);

    const raised = await coord.patch(`/api/shifts/${shiftId}`).send({ requiredHeadcount: 3 });
    expect(raised.status).toBe(200);
    expect(raised.body.shift.state).toBe('partially_filled');

    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [], dismissed: [shiftId] });
  });

  it('stays dismissed when a cancellation only takes a Partially Filled shift down to Open', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(2), requiredHeadcount: 2 });
    const signup = await vols[0].post(`/api/shifts/${shiftId}/signups`);
    expect(signup.status).toBe(201);
    expect((await dismiss(coord, shiftId)).status).toBe(204);

    expect((await vols[0].post(`/api/signups/${signup.body.signup.id}/cancel`)).status).toBe(204);

    expect(await alertIdsAmong(coord, [shiftId])).toEqual({ alerts: [], dismissed: [shiftId] });
  });
});
