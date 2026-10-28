import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import type { TimelineEntry } from '../src/shifts/service';
import { createUser, dayFromToday, eventsFor, insertShift, setupProgram, signIn, type Agent } from './helpers';

/** Reads a shift's timeline through the API as `agent`. */
async function timelineOf(agent: Agent, shiftId: number): Promise<TimelineEntry[]> {
  const res = await agent.get(`/api/shifts/${shiftId}/timeline`);
  expect(res.status).toBe(200);
  return res.body.events;
}

/**
 * Runs one statement inside a transaction that is always rolled back, so even if the database
 * wrongly accepted it, the history the other tests rely on would survive.
 */
async function attemptThenRollBack(sql: string, params: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, params);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('what a shift timeline records', () => {
  it('shows creation, each signup and cancellation with who made it, each fill-state change and notes, oldest first', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const [ana, ben] = volunteers;
    const created = await coord.post(`/api/programs/${program.id}/shifts`).send({
      date: dayFromToday(6),
      startTime: '09:00',
      durationMinutes: 180,
      location: 'Riverside Depot',
      requiredHeadcount: 2,
    });
    expect(created.status).toBe(201);
    const shiftId: number = created.body.shift.id;

    const anaSignup = await vols[0].post(`/api/shifts/${shiftId}/signups`); // Ana signs herself up
    expect(anaSignup.status).toBe(201);
    const benSignup = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: ben.id }); // on Ben's behalf
    expect(benSignup.status).toBe(201);
    expect((await coord.post(`/api/shifts/${shiftId}/notes`).send({ note: 'Bring gloves and water.' })).status).toBe(201);
    expect((await vols[0].post(`/api/signups/${anaSignup.body.signup.id}/cancel`)).status).toBe(204);
    expect((await coord.post(`/api/signups/${benSignup.body.signup.id}/cancel`)).status).toBe(204);

    const events = await timelineOf(coord, shiftId);
    expect(events).toMatchObject([
      {
        type: 'created',
        actor: { id: coordinator.id, name: coordinator.name, role: 'coordinator' },
        details: { location: 'Riverside Depot', requiredHeadcount: 2 },
      },
      { type: 'signup_created', actor: { id: ana.id, name: ana.name, role: 'volunteer' }, volunteer: { id: ana.id, name: ana.name } },
      { type: 'state_changed', fromState: 'open', toState: 'partially_filled', actor: { id: ana.id } },
      { type: 'signup_created', actor: { id: coordinator.id, role: 'coordinator' }, volunteer: { id: ben.id, name: ben.name } },
      { type: 'state_changed', fromState: 'partially_filled', toState: 'filled', actor: { id: coordinator.id } },
      { type: 'note', note: 'Bring gloves and water.', actor: { id: coordinator.id, name: coordinator.name } },
      { type: 'signup_cancelled', actor: { id: ana.id }, volunteer: { id: ana.id } },
      { type: 'state_changed', fromState: 'filled', toState: 'partially_filled', actor: { id: ana.id } },
      { type: 'signup_cancelled', actor: { id: coordinator.id }, volunteer: { id: ben.id } },
      { type: 'state_changed', fromState: 'partially_filled', toState: 'open', actor: { id: coordinator.id } },
    ]);

    // Oldest first, and every entry says when it happened.
    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const times = events.map((e) => Date.parse(e.createdAt));
    expect(times.every(Number.isFinite)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('shows fill-state changes from a headcount edit and from closing, each with old and new state', async () => {
    const { coordinator, program, volunteers, coord } = await setupProgram(1);
    // Yesterday's shift: the coordinator records a walk-in, lowers the headcount, then closes it.
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(-1), requiredHeadcount: 2 });
    expect((await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[0].id })).status).toBe(201);
    expect((await coord.patch(`/api/shifts/${shiftId}`).send({ requiredHeadcount: 1 })).status).toBe(200);
    expect((await coord.post(`/api/shifts/${shiftId}/close`)).status).toBe(200);

    const events = await timelineOf(coord, shiftId);
    expect(events.map((e) => e.type)).toEqual([
      'created',
      'signup_created',
      'state_changed',
      'updated',
      'state_changed',
      'state_changed',
    ]);
    expect(events.slice(3)).toMatchObject([
      { type: 'updated', actor: { id: coordinator.id }, details: { changes: { requiredHeadcount: { from: 2, to: 1 } } } },
      { type: 'state_changed', fromState: 'partially_filled', toState: 'filled', actor: { id: coordinator.id } },
      { type: 'state_changed', fromState: 'filled', toState: 'closed', actor: { id: coordinator.id } },
    ]);
  });

  it('starts with a creation entry for shifts made by the recurring generator too', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const firstDate = dayFromToday(10);
    const res = await coord.post(`/api/programs/${program.id}/shifts/generate`).send({
      startDate: firstDate,
      endDate: dayFromToday(17),
      dayOfWeek: new Date(`${firstDate}T00:00:00Z`).getUTCDay(),
      startTime: '08:00',
      durationMinutes: 60,
      location: 'Trailhead',
      requiredHeadcount: 3,
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);

    for (const shift of res.body.created as { id: number }[]) {
      expect(await timelineOf(coord, shift.id)).toMatchObject([
        { type: 'created', actor: { id: coordinator.id }, details: { source: 'recurring', location: 'Trailhead' } },
      ]);
    }
  });

  it('records a cancellation caused by removing the volunteer from the program, with who did it and why', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const [ana] = volunteers;
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5), requiredHeadcount: 2 });
    expect((await vols[0].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);

    const removed = await coord.delete(`/api/programs/${program.id}/members/${ana.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.cancelledSignups).toBe(1);

    const events = await timelineOf(coord, shiftId);
    expect(events.slice(-2)).toMatchObject([
      {
        type: 'signup_cancelled',
        actor: { id: coordinator.id, role: 'coordinator' },
        volunteer: { id: ana.id, name: ana.name },
        details: { reason: 'removed_from_program' },
      },
      { type: 'state_changed', fromState: 'partially_filled', toState: 'open', actor: { id: coordinator.id } },
    ]);
  });
});

describe('coordinator notes', () => {
  it('can only be added by coordinators; each shows its author, and the program members can read them', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });

    const byVolunteer = await vols[0].post(`/api/shifts/${shiftId}/notes`).send({ note: 'I might be late.' });
    expect(byVolunteer.status).toBe(403);
    expect(byVolunteer.body.error.code).toBe('FORBIDDEN');
    expect(byVolunteer.body.error.message).toMatch(/only coordinators/i);

    expect((await coord.post(`/api/shifts/${shiftId}/notes`).send({ note: 'Gate code is 4412.' })).status).toBe(201);

    const notes = (await timelineOf(vols[0], shiftId)).filter((e) => e.type === 'note');
    expect(notes).toMatchObject([
      { note: 'Gate code is 4412.', actor: { id: coordinator.id, name: coordinator.name, role: 'coordinator' } },
    ]);
  });

  it('refuses an empty note and says why', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });

    const res = await coord.post(`/api/shifts/${shiftId}/notes`).send({ note: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/write a note/i);
    expect((await timelineOf(coord, shiftId)).map((e) => e.type)).toEqual(['created']);
  });
});

describe('who can read a timeline', () => {
  it('hides it from a volunteer outside the program, without revealing that the shift exists', async () => {
    const { coordinator, program } = await setupProgram(0);
    const outsider = await signIn(await createUser('volunteer'));
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });

    const res = await outsider.get(`/api/shifts/${shiftId}/timeline`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/not a member/);
  });
});

describe('a timeline cannot be rewritten', () => {
  it('offers no API to edit or delete entries or notes, even to a coordinator', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
    expect((await coord.post(`/api/shifts/${shiftId}/notes`).send({ note: 'Original note' })).status).toBe(201);
    const before = await timelineOf(coord, shiftId);
    const noteId = before.find((e) => e.type === 'note')?.id;
    expect(noteId).toBeDefined();

    const rewrite = { note: 'Rewritten note' };
    const attempts = {
      'PATCH timeline entry': () => coord.patch(`/api/shifts/${shiftId}/timeline/${noteId}`).send(rewrite),
      'PUT timeline entry': () => coord.put(`/api/shifts/${shiftId}/timeline/${noteId}`).send(rewrite),
      'DELETE timeline entry': () => coord.delete(`/api/shifts/${shiftId}/timeline/${noteId}`),
      'PATCH whole timeline': () => coord.patch(`/api/shifts/${shiftId}/timeline`).send(rewrite),
      'DELETE whole timeline': () => coord.delete(`/api/shifts/${shiftId}/timeline`),
      'PATCH note': () => coord.patch(`/api/shifts/${shiftId}/notes/${noteId}`).send(rewrite),
      'PUT note': () => coord.put(`/api/shifts/${shiftId}/notes/${noteId}`).send(rewrite),
      'DELETE note': () => coord.delete(`/api/shifts/${shiftId}/notes/${noteId}`),
      'DELETE all notes': () => coord.delete(`/api/shifts/${shiftId}/notes`),
      'PATCH /api/notes/:id': () => coord.patch(`/api/notes/${noteId}`).send(rewrite),
      'DELETE /api/timeline/:id': () => coord.delete(`/api/timeline/${noteId}`),
      // Nor can anyone write an entry of their own choosing, such as a made-up state change.
      'POST forged entry': () =>
        coord.post(`/api/shifts/${shiftId}/timeline`).send({ type: 'state_changed', fromState: 'open', toState: 'filled' }),
    };
    for (const [attempt, send] of Object.entries(attempts)) {
      const res = await send();
      expect([404, 405], `${attempt} answered ${res.status}`).toContain(res.status);
    }

    expect(await timelineOf(coord, shiftId)).toEqual(before);
  });

  it('is append-only in the database itself: UPDATE, DELETE and TRUNCATE on shift_events all fail', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
    expect((await coord.post(`/api/shifts/${shiftId}/notes`).send({ note: 'Original note' })).status).toBe(201);
    const before = await eventsFor(shiftId);

    await expect(
      attemptThenRollBack("UPDATE shift_events SET note = 'Rewritten note' WHERE shift_id = $1 AND event_type = 'note'", [shiftId]),
    ).rejects.toThrow(/append-only: UPDATE on shift_events is not allowed/);
    await expect(attemptThenRollBack('DELETE FROM shift_events WHERE shift_id = $1', [shiftId])).rejects.toThrow(
      /append-only: DELETE on shift_events is not allowed/,
    );
    await expect(attemptThenRollBack('TRUNCATE shift_events')).rejects.toThrow(
      /append-only: TRUNCATE on shift_events is not allowed/,
    );

    expect(await eventsFor(shiftId)).toEqual(before);
  });

  it('cannot be lost by hard-deleting the shift row: the database refuses', async () => {
    const { coordinator, program } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });

    await expect(attemptThenRollBack('DELETE FROM shifts WHERE id = $1', [shiftId])).rejects.toThrow(
      /violates foreign key constraint "shift_events_shift_id_fkey"/,
    );
    expect((await eventsFor(shiftId)).map((e) => e.event_type)).toEqual(['created']);
  });
});
