import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import {
  addMember,
  createProgram,
  createUser,
  dayFromToday,
  eventsFor,
  insertShift,
  setupProgram,
  shiftState,
  signIn,
} from './helpers';

describe('fill state is derived from signups', () => {
  it('moves Open -> Partially Filled -> Filled and back, recording every change', async () => {
    const { coordinator, program, volunteers, vols } = await setupProgram(3);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5), requiredHeadcount: 2 });
    expect((await shiftState(shiftId)).state).toBe('open');

    expect((await vols[0].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);
    expect((await shiftState(shiftId)).state).toBe('partially_filled');

    const second = await vols[1].post(`/api/shifts/${shiftId}/signups`);
    expect(second.status).toBe(201);
    expect(await shiftState(shiftId)).toEqual({ state: 'filled', signup_count: 2 });

    const third = await vols[2].post(`/api/shifts/${shiftId}/signups`);
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('SHIFT_FILLED');
    expect(third.body.error.message).toMatch(/already filled/);

    expect((await vols[1].post(`/api/signups/${second.body.signup.id}/cancel`)).status).toBe(204);
    expect(await shiftState(shiftId)).toEqual({ state: 'partially_filled', signup_count: 1 });

    const transitions = (await eventsFor(shiftId))
      .filter((e) => e.event_type === 'state_changed')
      .map((e) => `${e.from_state}->${e.to_state}`);
    expect(transitions).toEqual(['open->partially_filled', 'partially_filled->filled', 'filled->partially_filled']);

    const signupEvents = (await eventsFor(shiftId)).filter((e) => e.event_type.startsWith('signup_'));
    expect(signupEvents.map((e) => [e.event_type, e.actor_id, e.volunteer_id])).toEqual([
      ['signup_created', volunteers[0].id, volunteers[0].id],
      ['signup_created', volunteers[1].id, volunteers[1].id],
      ['signup_cancelled', volunteers[1].id, volunteers[1].id],
    ]);
  });

  it('cannot be set by hand through the API', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
    const res = await coord.patch(`/api/shifts/${shiftId}`).send({ state: 'filled', location: 'Annex' });
    expect(res.status).toBe(200);
    expect(res.body.shift).toMatchObject({ state: 'open', location: 'Annex' });
  });

  it('cannot be set by hand in the database either', async () => {
    const coordinator = await createUser('coordinator');
    const program = await createProgram(coordinator);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
    await expect(pool.query("UPDATE shifts SET state = 'filled' WHERE id = $1", [shiftId])).rejects.toThrow(
      /column "state" can only be updated to DEFAULT/,
    );
  });
});

describe('signup rules', () => {
  it('lets only one of two simultaneous requests take the last spot', async () => {
    const { coordinator, program, vols } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4), requiredHeadcount: 1 });

    const results = await Promise.all(vols.map((agent) => agent.post(`/api/shifts/${shiftId}/signups`)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await shiftState(shiftId)).toEqual({ state: 'filled', signup_count: 1 });
  });

  it('rejects a signup that overlaps one the volunteer holds in another program', async () => {
    const coordinator = await createUser('coordinator');
    const volunteer = await createUser('volunteer');
    const pantry = await createProgram(coordinator, 'Food Pantry overlap test');
    const trail = await createProgram(coordinator);
    await addMember(pantry.id, volunteer, coordinator);
    await addMember(trail.id, volunteer, coordinator);
    const date = dayFromToday(6);
    const pantryShift = await insertShift(pantry.id, coordinator, { date, startTime: '10:00', durationMinutes: 120 });
    const overlapping = await insertShift(trail.id, coordinator, { date, startTime: '11:00', durationMinutes: 120 });
    const touching = await insertShift(trail.id, coordinator, { date, startTime: '12:00', durationMinutes: 60 });

    const agent = await signIn(volunteer);
    expect((await agent.post(`/api/shifts/${pantryShift}/signups`)).status).toBe(201);

    const clash = await agent.post(`/api/shifts/${overlapping}/signups`);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SIGNUP_OVERLAP');
    expect(clash.body.error.message).toContain('Food Pantry overlap test');

    // 12:00 starts exactly when the 10:00-12:00 shift ends: back-to-back is fine.
    expect((await agent.post(`/api/shifts/${touching}/signups`)).status).toBe(201);
  });

  // Regression test: before volunteer schedule locks, about 1 in 12 of these races hit a deadlock
  // inside the EXCLUDE constraint check and returned 500. Repeat it to make that visible.
  it('cannot double-book a volunteer even when both requests arrive at once', async () => {
    const coordinator = await createUser('coordinator');
    const program = await createProgram(coordinator);
    for (let round = 0; round < 20; round += 1) {
      const volunteer = await createUser('volunteer');
      await addMember(program.id, volunteer, coordinator);
      const date = dayFromToday(7 + round);
      const a = await insertShift(program.id, coordinator, { date, startTime: '09:00' });
      const b = await insertShift(program.id, coordinator, { date, startTime: '10:00' });

      const agent = await signIn(volunteer);
      const results = await Promise.all([a, b].map((id) => agent.post(`/api/shifts/${id}/signups`)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.error.code).toBe('SIGNUP_OVERLAP');
      const { rows } = await pool.query(
        'SELECT count(*) AS active FROM signups WHERE volunteer_id = $1 AND cancelled_at IS NULL',
        [volunteer.id],
      );
      expect(rows[0].active).toBe(1);
    }
  });

  it('rejects signing up twice for the same shift', async () => {
    const { coordinator, program, vols } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(3) });
    await vols[0].post(`/api/shifts/${shiftId}/signups`);
    const again = await vols[0].post(`/api/shifts/${shiftId}/signups`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SIGNED_UP');
  });

  it('rejects signups once the shift has started', async () => {
    const { coordinator, program, vols } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(-1) });
    const res = await vols[0].post(`/api/shifts/${shiftId}/signups`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFT_STARTED');
  });

  it('lets a coordinator sign up a member, but not a non-member', async () => {
    const { coordinator, program, volunteers, coord } = await setupProgram(1);
    const outsider = await createUser('volunteer', 'Outsider Olu');
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(3) });

    const ok = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[0].id });
    expect(ok.status).toBe(201);
    const events = await eventsFor(shiftId);
    expect(events.find((e) => e.event_type === 'signup_created')).toMatchObject({
      actor_id: coordinator.id,
      volunteer_id: volunteers[0].id,
    });

    const notMember = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: outsider.id });
    expect(notMember.status).toBe(409);
    expect(notMember.body.error.code).toBe('NOT_A_MEMBER');
    expect(notMember.body.error.message).toContain('Outsider Olu');
  });

  it("does not let a volunteer sign up or cancel someone else", async () => {
    const { coordinator, program, volunteers, vols } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(3) });

    const forOther = await vols[0].post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[1].id });
    expect(forOther.status).toBe(403);

    const theirs = await vols[1].post(`/api/shifts/${shiftId}/signups`);
    const cancelOther = await vols[0].post(`/api/signups/${theirs.body.signup.id}/cancel`);
    expect(cancelOther.status).toBe(403);
    expect((await shiftState(shiftId)).signup_count).toBe(1);
  });
});

describe('cancellation rules', () => {
  it('stops volunteers cancelling a started shift, but lets a coordinator record a no-show', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(-1) });
    // Signup made before the shift started (inserted directly, as the API now refuses it).
    const { rows } = await pool.query(
      `INSERT INTO signups (shift_id, volunteer_id, time_range, created_by)
       SELECT id, $2, time_range, $2 FROM shifts WHERE id = $1 RETURNING id`,
      [shiftId, volunteers[0].id],
    );
    await pool.query('UPDATE shifts SET signup_count = 1 WHERE id = $1', [shiftId]);

    const byVolunteer = await vols[0].post(`/api/signups/${rows[0].id}/cancel`);
    expect(byVolunteer.status).toBe(409);
    expect(byVolunteer.body.error.code).toBe('SHIFT_STARTED');

    expect((await coord.post(`/api/signups/${rows[0].id}/cancel`)).status).toBe(204);
    expect(await shiftState(shiftId)).toEqual({ state: 'open', signup_count: 0 });
  });

  it('rejects cancelling twice', async () => {
    const { coordinator, program, vols } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(3) });
    const signup = await vols[0].post(`/api/shifts/${shiftId}/signups`);
    await vols[0].post(`/api/signups/${signup.body.signup.id}/cancel`);
    const again = await vols[0].post(`/api/signups/${signup.body.signup.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CANCELLED');
  });
});

describe('closing', () => {
  it('only closes a shift after its scheduled time has passed', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const future = await insertShift(program.id, coordinator, { date: dayFromToday(2) });
    const res = await coord.post(`/api/shifts/${future}/close`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFT_NOT_OVER');
  });

  it('locks a closed shift against signups, cancellations, edits and deletion', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(-2), requiredHeadcount: 3 });
    const { rows } = await pool.query(
      `INSERT INTO signups (shift_id, volunteer_id, time_range, created_by)
       SELECT id, $2, time_range, $2 FROM shifts WHERE id = $1 RETURNING id`,
      [shiftId, volunteers[0].id],
    );
    await pool.query('UPDATE shifts SET signup_count = 1 WHERE id = $1', [shiftId]);

    const closed = await coord.post(`/api/shifts/${shiftId}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.shift.state).toBe('closed');
    const stateEvents = (await eventsFor(shiftId)).filter((e) => e.event_type === 'state_changed');
    expect(stateEvents.at(-1)).toMatchObject({ from_state: 'partially_filled', to_state: 'closed', actor_id: coordinator.id });

    const attempts = [
      await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteers[1].id }),
      await vols[0].post(`/api/signups/${rows[0].id}/cancel`),
      await coord.post(`/api/signups/${rows[0].id}/cancel`),
      await coord.patch(`/api/shifts/${shiftId}`).send({ location: 'Elsewhere' }),
      await coord.delete(`/api/shifts/${shiftId}`),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(409);
      expect(attempt.body.error.code).toBe('SHIFT_CLOSED');
    }
    expect((await coord.post(`/api/shifts/${shiftId}/close`)).body.error.code).toBe('ALREADY_CLOSED');
    expect(await shiftState(shiftId)).toEqual({ state: 'closed', signup_count: 1 });
  });
});

describe('editing and deleting shifts', () => {
  it('re-derives the fill state when the required headcount changes, but never below the signups', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5), requiredHeadcount: 2 });
    await vols[0].post(`/api/shifts/${shiftId}/signups`);
    await vols[1].post(`/api/shifts/${shiftId}/signups`);

    const tooLow = await coord.patch(`/api/shifts/${shiftId}`).send({ requiredHeadcount: 1 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error.code).toBe('HEADCOUNT_BELOW_SIGNUPS');

    const raised = await coord.patch(`/api/shifts/${shiftId}`).send({ requiredHeadcount: 4 });
    expect(raised.body.shift).toMatchObject({ state: 'partially_filled', spotsLeft: 2 });
    const last = (await eventsFor(shiftId)).at(-1);
    expect(last).toMatchObject({ event_type: 'state_changed', from_state: 'filled', to_state: 'partially_filled' });
  });

  it('refuses to move a shift onto a time that would double-book one of its volunteers', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(1);
    const date = dayFromToday(8);
    const morning = await insertShift(program.id, coordinator, { date, startTime: '09:00', durationMinutes: 60 });
    const afternoon = await insertShift(program.id, coordinator, { date, startTime: '14:00', durationMinutes: 60 });
    await vols[0].post(`/api/shifts/${morning}/signups`);
    await vols[0].post(`/api/shifts/${afternoon}/signups`);

    const res = await coord.patch(`/api/shifts/${afternoon}`).send({ startTime: '09:30' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SIGNUP_OVERLAP');

    const fine = await coord.patch(`/api/shifts/${afternoon}`).send({ startTime: '15:00' });
    expect(fine.status).toBe(200);
    expect(fine.body.shift.startTime).toBe('15:00');
  });

  it('soft-deletes: signups are cancelled, the shift disappears, its history stays', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4) });
    await vols[0].post(`/api/shifts/${shiftId}/signups`);

    const res = await coord.delete(`/api/shifts/${shiftId}`);
    expect(res.status).toBe(200);
    expect(res.body.cancelledSignups).toBe(1);
    expect((await coord.get(`/api/shifts/${shiftId}`)).status).toBe(404);

    const types = (await eventsFor(shiftId)).map((e) => e.event_type);
    expect(types).toEqual(['created', 'signup_created', 'state_changed', 'signup_cancelled', 'state_changed', 'deleted']);
  });
});
