import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
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
  shiftState,
  signIn,
  unique,
} from './helpers';

// Goal 2 (programs: create, edit, archive, restore) and goal 5 (membership, and every volunteer's
// one list of their programs and the shifts in them).

interface ShiftView {
  id: number;
  state: string;
  mySignupId: number | null;
}

interface MyProgramView {
  id: number;
  shifts: ShiftView[];
}

/** A valid id that no row will ever have in a test run. */
const NO_SUCH_ID = 2_000_000_000;

/** Ids in a list response, sorted, so assertions don't depend on the server's ordering. */
function ids(items: { id: number }[]): number[] {
  return items.map((item) => item.id).sort((a, b) => a - b);
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function fieldsOf(res: { body: { error: { details: { field: string }[] } } }): string[] {
  return res.body.error.details.map((detail) => detail.field);
}

/** One program's shifts in a GET /api/me/programs response, as [shift id, mySignupId] pairs. */
function shiftsIn(programs: MyProgramView[], programId: number): [number, number | null][] {
  const program = programs.find((p) => p.id === programId);
  if (!program) throw new Error(`Program ${programId} is missing from the list`);
  return program.shifts
    .map((shift): [number, number | null] => [shift.id, shift.mySignupId])
    .sort((a, b) => a[0] - b[0]);
}

async function signupIsActive(signupId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT cancelled_at IS NULL AS active FROM signups WHERE id = $1', [signupId]);
  return rows[0].active;
}

/** Organisation-local date and HH:MM `minutes` ago, for building a shift that is already under way. */
function startedMinutesAgo(minutes: number): { date: string; startTime: string } {
  // Do the arithmetic on the wall-clock reading as if it were UTC, so crossing midnight is safe.
  const wallClock = new Date(`${orgClock().now.replace(' ', 'T')}Z`);
  wallClock.setUTCMinutes(wallClock.getUTCMinutes() - minutes);
  const iso = wallClock.toISOString();
  return { date: iso.slice(0, 10), startTime: iso.slice(11, 16) };
}

describe('creating and editing programs', () => {
  it('lets a coordinator create a program with a name and a description', async () => {
    const coord = await signIn(await createUser('coordinator'));
    const name = `Food Pantry ${unique()}`;

    const res = await coord.post('/api/programs').send({ name: `  ${name}  `, description: 'Sort and pack donations.' });
    expect(res.status).toBe(201);
    expect(res.body.program).toMatchObject({
      name, // surrounding spaces trimmed
      description: 'Sort and pack donations.',
      archived: false,
      archivedAt: null,
      memberCount: 0,
      upcomingShiftCount: 0,
    });
    expect((await coord.get(`/api/programs/${res.body.program.id}`)).body.program).toEqual(res.body.program);
    expect(ids((await coord.get('/api/programs')).body.programs)).toContain(res.body.program.id);

    const noDescription = await coord.post('/api/programs').send({ name: `Trail Cleanup ${unique()}` });
    expect(noDescription.status).toBe(201);
    expect(noDescription.body.program.description).toBe('');
  });

  it('rejects a missing, blank, over-long or non-text name, naming the field', async () => {
    const coord = await signIn(await createUser('coordinator'));
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 42 }]) {
      const res = await coord.post('/api/programs').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/^Invalid input — name: /);
      expect(fieldsOf(res)).toEqual(['name']);
    }
    const blank = await coord.post('/api/programs').send({ name: '   ' });
    expect(blank.body.error.message).toContain('Name is required');

    const longDescription = await coord.post('/api/programs').send({ name: 'Reading Buddies', description: 'x'.repeat(2001) });
    expect(longDescription.status).toBe(400);
    expect(fieldsOf(longDescription)).toEqual(['description']);
  });

  it('rejects unknown fields instead of ignoring them, so archiving cannot be smuggled into a create or an edit', async () => {
    const { program, coord } = await setupProgram(0);

    const created = await coord.post('/api/programs').send({ name: `Night Shelter ${unique()}`, archived: true });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/Unrecognized key.*archived/);

    const edited = await coord.patch(`/api/programs/${program.id}`).send({ archivedAt: '2026-01-01T00:00:00Z' });
    expect(edited.status).toBe(400);
    expect(edited.body.error.message).toMatch(/Unrecognized key.*archivedAt/);
    expect((await coord.get(`/api/programs/${program.id}`)).body.program.archived).toBe(false);
  });

  it('edits the name and the description independently', async () => {
    const { program, coord } = await setupProgram(0);
    const newName = `Homework Club ${unique()}`;

    const renamed = await coord.patch(`/api/programs/${program.id}`).send({ name: newName });
    expect(renamed.status).toBe(200);
    expect(renamed.body.program).toMatchObject({ id: program.id, name: newName, description: '' });

    const described = await coord.patch(`/api/programs/${program.id}`).send({ description: 'Maths and reading, after school.' });
    expect(described.status).toBe(200);
    expect(described.body.program).toMatchObject({ name: newName, description: 'Maths and reading, after school.' });

    const cleared = await coord.patch(`/api/programs/${program.id}`).send({ description: '' });
    expect(cleared.body.program).toMatchObject({ name: newName, description: '' });
    expect((await coord.get(`/api/programs/${program.id}`)).body.program).toMatchObject({ name: newName, description: '' });
  });

  it('rejects an edit with nothing to change or a blank name, and changes nothing', async () => {
    const { program, coord } = await setupProgram(0);

    const empty = await coord.patch(`/api/programs/${program.id}`).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toMatch(/Send at least one field to change/);

    const blank = await coord.patch(`/api/programs/${program.id}`).send({ name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.message).toMatch(/name: Name is required/);

    expect((await coord.get(`/api/programs/${program.id}`)).body.program.name).toBe(program.name);
  });

  it('reports an unknown program as not found', async () => {
    const coord = await signIn(await createUser('coordinator'));
    const attempts = [
      await coord.get(`/api/programs/${NO_SUCH_ID}`),
      await coord.patch(`/api/programs/${NO_SUCH_ID}`).send({ name: 'Ghost' }),
      await coord.post(`/api/programs/${NO_SUCH_ID}/archive`),
      await coord.post(`/api/programs/${NO_SUCH_ID}/restore`),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Program not found.' });
    }
  });

  it('lets only coordinators create, edit, archive or restore programs', async () => {
    const { program, vols } = await setupProgram(1);
    const attempts = [
      await vols[0].post('/api/programs').send({ name: `My Own Program ${unique()}` }),
      await vols[0].patch(`/api/programs/${program.id}`).send({ name: 'Renamed by a volunteer' }),
      await vols[0].post(`/api/programs/${program.id}/archive`),
      await vols[0].post(`/api/programs/${program.id}/restore`),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only coordinators can do that.' });
    }
    expect((await vols[0].get(`/api/programs/${program.id}`)).body.program).toMatchObject({
      name: program.name,
      archived: false,
    });

    const anonymous = await request(app).post('/api/programs').send({ name: `Anonymous ${unique()}` });
    expect(anonymous.status).toBe(401);
  });
});

describe('archiving and restoring', () => {
  it('moves a program out of the default list and into ?archived=true, and back again on restore', async () => {
    const { program, coord } = await setupProgram(0);
    const listedIn = async () => ({
      active: ids((await coord.get('/api/programs')).body.programs).includes(program.id),
      archived: ids((await coord.get('/api/programs?archived=true')).body.programs).includes(program.id),
    });
    expect(await listedIn()).toEqual({ active: true, archived: false });

    const archived = await coord.post(`/api/programs/${program.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.program).toMatchObject({ id: program.id, archived: true, archivedAt: expect.any(String) });
    expect(await listedIn()).toEqual({ active: false, archived: true });
    // Hidden from the default list, not gone: a coordinator can still open it.
    expect((await coord.get(`/api/programs/${program.id}`)).body.program.archived).toBe(true);

    const restored = await coord.post(`/api/programs/${program.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.program).toMatchObject({ archived: false, archivedAt: null });
    expect(await listedIn()).toEqual({ active: true, archived: false });

    const badFilter = await coord.get('/api/programs?archived=yes');
    expect(badFilter.status).toBe(400);
    expect(fieldsOf(badFilter)).toEqual(['archived']);
  });

  it("takes an archived program's shifts out of the shift list, alerts and dashboard until it is restored", async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    // Open and dated tomorrow, so it is also an understaffing alert.
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1) });
    const shownIn = async () => ({
      shiftList: (await coord.get('/api/shifts').query({ q: program.name, pageSize: 100 })).body.items.some(
        (shift: ShiftView) => shift.id === shiftId,
      ),
      alerts: (await coord.get('/api/alerts')).body.alerts.some((shift: ShiftView) => shift.id === shiftId),
      dashboard: (await coord.get('/api/dashboard')).body.byProgram.some(
        (row: { programId: number }) => row.programId === program.id,
      ),
    });
    expect(await shownIn()).toEqual({ shiftList: true, alerts: true, dashboard: true });

    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);
    expect(await shownIn()).toEqual({ shiftList: false, alerts: false, dashboard: false });
    // The shift still exists: opening the archived program shows it, marked read-only.
    const opened = await coord.get('/api/shifts').query({ programId: program.id });
    expect(opened.body.items).toMatchObject([{ id: shiftId, programArchived: true }]);

    expect((await coord.post(`/api/programs/${program.id}/restore`)).status).toBe(200);
    expect(await shownIn()).toEqual({ shiftList: true, alerts: true, dashboard: true });
  });

  it('keeps every shift, signup, member and history entry while archived, and restores them unchanged', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    // A shift that happened and was closed, and an upcoming one with a cancelled signup and a note.
    const worked = await insertShift(program.id, coordinator, { date: dayFromToday(-3) });
    await insertSignup(worked, volunteers[0]);
    expect((await coord.post(`/api/shifts/${worked}/close`)).status).toBe(200);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(6), requiredHeadcount: 3 });
    const signup = await vols[1].post(`/api/shifts/${upcoming}/signups`);
    expect((await vols[1].post(`/api/signups/${signup.body.signup.id}/cancel`)).status).toBe(204);
    expect((await coord.post(`/api/shifts/${upcoming}/notes`).send({ note: 'Bring gloves' })).status).toBe(201);

    const snapshot = async () => ({
      program: (await coord.get(`/api/programs/${program.id}`)).body.program,
      members: (await coord.get(`/api/programs/${program.id}/members`)).body.members,
      shifts: (await coord.get('/api/shifts').query({ programId: program.id })).body.items,
      timelines: [
        (await coord.get(`/api/shifts/${worked}/timeline`)).body.events,
        (await coord.get(`/api/shifts/${upcoming}/timeline`)).body.events,
      ],
      signups: (
        await pool.query(
          'SELECT su.* FROM signups su JOIN shifts s ON s.id = su.shift_id WHERE s.program_id = $1 ORDER BY su.id',
          [program.id],
        )
      ).rows,
    });
    const before = await snapshot();
    expect(before.shifts).toHaveLength(2);
    expect(before.signups).toHaveLength(2);

    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);
    const whileArchived = await snapshot();
    expect(whileArchived.program.archived).toBe(true);
    expect(whileArchived.members).toEqual(before.members);
    expect(ids(whileArchived.shifts)).toEqual(ids(before.shifts));
    expect(whileArchived.timelines).toEqual(before.timelines);
    expect(whileArchived.signups).toEqual(before.signups);

    expect((await coord.post(`/api/programs/${program.id}/restore`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to archive while shifts that have not started hold signups, saying how many and what to do', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(2);
    const first = await insertShift(program.id, coordinator, { date: dayFromToday(4), requiredHeadcount: 3 });
    const second = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
    await vols[0].post(`/api/shifts/${first}/signups`);
    await vols[1].post(`/api/shifts/${first}/signups`);
    await vols[0].post(`/api/shifts/${second}/signups`);

    const res = await coord.post(`/api/programs/${program.id}/archive`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ARCHIVE_HAS_UPCOMING_SIGNUPS');
    expect(res.body.error.message).toContain(`${program.name} still has 3 upcoming signups on 2 shifts.`);
    expect(res.body.error.message).toMatch(/Cancel them or delete those shifts before archiving/);

    expect((await coord.get(`/api/programs/${program.id}`)).body.program.archived).toBe(false);
    expect(await shiftState(first)).toEqual({ state: 'partially_filled', signup_count: 2 });
  });

  it('archives once upcoming signups are cancelled or their shifts deleted, leaving signups on shifts that already started', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const worked = await insertShift(program.id, coordinator, { date: dayFromToday(-1) });
    const workedSignup = await insertSignup(worked, volunteers[0]);
    const toCancel = await insertShift(program.id, coordinator, { date: dayFromToday(3) });
    const toDelete = await insertShift(program.id, coordinator, { date: dayFromToday(4) });
    const signup = await vols[0].post(`/api/shifts/${toCancel}/signups`);
    await vols[0].post(`/api/shifts/${toDelete}/signups`);

    const refused = await coord.post(`/api/programs/${program.id}/archive`);
    expect(refused.body.error.message).toContain('2 upcoming signups on 2 shifts.');
    expect((await coord.post(`/api/signups/${signup.body.signup.id}/cancel`)).status).toBe(204);
    const stillRefused = await coord.post(`/api/programs/${program.id}/archive`);
    expect(stillRefused.body.error.message).toContain('1 upcoming signup on 1 shift.');
    expect((await coord.delete(`/api/shifts/${toDelete}`)).status).toBe(200);

    const archived = await coord.post(`/api/programs/${program.id}/archive`);
    expect(archived.status).toBe(200);
    // The signup on the shift that already happened is kept exactly as it was.
    expect(await signupIsActive(workedSignup)).toBe(true);
    expect(await shiftState(worked)).toEqual({ state: 'partially_filled', signup_count: 1 });
  });

  it('rejects archiving twice and restoring a program that is not archived', async () => {
    const { program, coord } = await setupProgram(0);

    const restoreActive = await coord.post(`/api/programs/${program.id}/restore`);
    expect(restoreActive.status).toBe(409);
    expect(restoreActive.body.error).toMatchObject({ code: 'NOT_ARCHIVED', message: `${program.name} is not archived.` });

    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);
    const again = await coord.post(`/api/programs/${program.id}/archive`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ALREADY_ARCHIVED', message: `${program.name} is already archived.` });
  });

  it('never lets an archive and a signup for an upcoming shift both succeed at the same moment', async () => {
    const coordinator = await createUser('coordinator');
    const coord = await signIn(coordinator);
    for (let round = 0; round < 10; round += 1) {
      const program = await createProgram(coordinator);
      const volunteer = await createUser('volunteer');
      await addMember(program.id, volunteer, coordinator);
      const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
      const vol = await signIn(volunteer);

      const [archive, signup] = await Promise.all([
        coord.post(`/api/programs/${program.id}/archive`),
        vol.post(`/api/shifts/${shiftId}/signups`),
      ]);
      // Either the archive went first (and the shift vanished for the volunteer), or the signup
      // went first (and blocked the archive). Never both.
      const outcome = [archive.body.error?.code ?? archive.status, signup.body.error?.code ?? signup.status];
      expect([
        [200, 'NOT_FOUND'],
        ['ARCHIVE_HAS_UPCOMING_SIGNUPS', 201],
      ]).toContainEqual(outcome);
    }
  });
});

describe('an archived program is frozen until restored', () => {
  it('refuses new or generated shifts and any change to its existing ones', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(6) });
    const finished = await insertShift(program.id, coordinator, { date: dayFromToday(-2) });
    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);

    const shift = { startTime: '09:00', durationMinutes: 120, location: 'Depot', requiredHeadcount: 2 };
    const attempts = {
      create: await coord.post(`/api/programs/${program.id}/shifts`).send({ date: dayFromToday(8), ...shift }),
      generate: await coord
        .post(`/api/programs/${program.id}/shifts/generate`)
        .send({ startDate: dayFromToday(7), endDate: dayFromToday(20), dayOfWeek: 6, ...shift }),
      edit: await coord.patch(`/api/shifts/${upcoming}`).send({ location: 'Elsewhere' }),
      delete: await coord.delete(`/api/shifts/${upcoming}`),
      close: await coord.post(`/api/shifts/${finished}/close`),
      note: await coord.post(`/api/shifts/${upcoming}/notes`).send({ note: 'Anyone free?' }),
    };
    for (const [action, res] of Object.entries(attempts)) {
      expect(res.status, action).toBe(409);
      expect(res.body.error.code, action).toBe('PROGRAM_ARCHIVED');
      expect(res.body.error.message, action).toContain(`${program.name} is archived. Restore the program`);
    }

    const { rows } = await pool.query('SELECT count(*) AS shifts FROM shifts WHERE program_id = $1', [program.id]);
    expect(rows[0].shifts).toBe(2);
    expect((await eventsFor(upcoming)).map((e) => e.event_type)).toEqual(['created']);
    expect((await shiftState(finished)).state).toBe('open');
  });

  it('refuses signups, cancellations and membership changes', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(6) });
    const finished = await insertShift(program.id, coordinator, { date: dayFromToday(-2) });
    const pastSignup = await insertSignup(finished, volunteers[0]);
    const newcomer = await createUser('volunteer');
    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);

    const attempts = {
      'sign up a member': await coord.post(`/api/shifts/${upcoming}/signups`).send({ volunteerId: volunteers[1].id }),
      'cancel a signup': await coord.post(`/api/signups/${pastSignup}/cancel`),
      'add a member': await coord.post(`/api/programs/${program.id}/members`).send({ userId: newcomer.id }),
      'remove a member': await coord.delete(`/api/programs/${program.id}/members/${volunteers[1].id}`),
    };
    for (const [action, res] of Object.entries(attempts)) {
      expect(res.status, action).toBe(409);
      expect(res.body.error.code, action).toBe('PROGRAM_ARCHIVED');
      expect(res.body.error.message, action).toContain(`${program.name} is archived. Restore the program`);
    }
    // Its own volunteers can't see an archived program at all, so to them the shift is not found.
    expect((await vols[1].post(`/api/shifts/${upcoming}/signups`)).status).toBe(404);

    const members = (await coord.get(`/api/programs/${program.id}/members`)).body.members;
    expect(ids(members)).toEqual(sorted(volunteers.map((v) => v.id)));
    expect(await signupIsActive(pastSignup)).toBe(true);
    expect((await shiftState(upcoming)).signup_count).toBe(0);
  });
});

describe('volunteers never see archived programs', () => {
  it('hides it from every list and answers "not found" for it, its shifts and their history', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const vol = vols[0];
    const worked = await insertShift(program.id, coordinator, { date: dayFromToday(-2) });
    const workedSignup = await insertSignup(worked, volunteers[0]);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(2) }); // understaffed: an alert
    expect(ids((await vol.get('/api/programs')).body.programs)).toEqual([program.id]);
    expect((await vol.get('/api/alerts')).body.alerts.map((s: ShiftView) => s.id)).toEqual([upcoming]);

    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);

    expect((await vol.get('/api/programs')).body.programs).toEqual([]);
    const archivedList = await vol.get('/api/programs?archived=true');
    expect(archivedList.status).toBe(200);
    expect(archivedList.body.programs).toEqual([]);
    expect((await vol.get('/api/me/programs')).body.programs).toEqual([]);
    expect((await vol.get('/api/shifts').query({ programId: program.id })).body.total).toBe(0);
    expect((await vol.get('/api/alerts')).body.alerts).toEqual([]);
    expect((await vol.get('/api/dashboard')).body.byProgram).toEqual([]);

    const attempts = [
      await vol.get(`/api/programs/${program.id}`),
      await vol.get(`/api/shifts/${worked}`),
      await vol.get(`/api/shifts/${worked}/timeline`),
      await vol.post(`/api/shifts/${upcoming}/signups`),
      await vol.post(`/api/signups/${workedSignup}/cancel`),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('shows it to them again, membership intact, once restored', async () => {
    const { coordinator, program, vols, coord } = await setupProgram(1);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(3) });
    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);
    expect((await coord.post(`/api/programs/${program.id}/restore`)).status).toBe(200);

    expect(ids((await vols[0].get('/api/programs')).body.programs)).toEqual([program.id]);
    expect((await vols[0].get(`/api/programs/${program.id}`)).status).toBe(200);
    expect((await vols[0].post(`/api/shifts/${upcoming}/signups`)).status).toBe(201);
  });
});

describe('program membership', () => {
  it('requires a volunteer to belong to a program before signing up for its shifts', async () => {
    const coordinator = await createUser('coordinator');
    const volunteer = await createUser('volunteer', `Newcomer ${unique()}`);
    const [coord, vol] = [await signIn(coordinator), await signIn(volunteer)];
    const program = await createProgram(coordinator);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4) });

    const selfSignup = await vol.post(`/api/shifts/${shiftId}/signups`);
    expect(selfSignup.status).toBe(404);
    expect(selfSignup.body.error.message).toMatch(/not a member/);

    const byCoordinator = await coord.post(`/api/shifts/${shiftId}/signups`).send({ volunteerId: volunteer.id });
    expect(byCoordinator.status).toBe(409);
    expect(byCoordinator.body.error.code).toBe('NOT_A_MEMBER');
    expect(byCoordinator.body.error.message).toContain(`${volunteer.name} isn't a member of ${program.name}`);
    expect(byCoordinator.body.error.message).toMatch(/Add them to the program first/);
    expect((await shiftState(shiftId)).signup_count).toBe(0);

    expect((await coord.post(`/api/programs/${program.id}/members`).send({ userId: volunteer.id })).status).toBe(201);
    expect((await vol.post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);
  });

  it('lets a volunteer belong to several programs and a program have several volunteers', async () => {
    const coordinator = await createUser('coordinator');
    const coord = await signIn(coordinator);
    const pantry = await createProgram(coordinator);
    const trail = await createProgram(coordinator);
    const ana = await createUser('volunteer');
    const ben = await createUser('volunteer');
    for (const [programId, user] of [
      [pantry.id, ana],
      [trail.id, ana],
      [pantry.id, ben],
    ] as const) {
      expect((await coord.post(`/api/programs/${programId}/members`).send({ userId: user.id })).status).toBe(201);
    }

    expect(ids((await coord.get(`/api/programs/${pantry.id}/members`)).body.members)).toEqual(sorted([ana.id, ben.id]));
    expect(ids((await coord.get(`/api/programs/${trail.id}/members`)).body.members)).toEqual([ana.id]);
    expect((await coord.get(`/api/programs/${pantry.id}`)).body.program.memberCount).toBe(2);

    // Each volunteer sees exactly the programs they belong to.
    const anaAgent = await signIn(ana);
    const benAgent = await signIn(ben);
    expect(ids((await anaAgent.get('/api/programs')).body.programs)).toEqual(sorted([pantry.id, trail.id]));
    expect(ids((await benAgent.get('/api/programs')).body.programs)).toEqual([pantry.id]);
    expect((await benAgent.get(`/api/programs/${trail.id}`)).status).toBe(404);
  });

  it('answers a volunteer the same way about a program they are not in as about one that does not exist', async () => {
    const coordinator = await createUser('coordinator');
    const elsewhere = await createProgram(coordinator);
    const vol = await signIn(await createUser('volunteer'));

    const notMine = await vol.get(`/api/programs/${elsewhere.id}`);
    expect(notMine.status).toBe(404);
    expect(notMine.body.error.message).toMatch(/not a member/);

    // An identical answer, so a volunteer cannot probe which program ids exist.
    const missing = await vol.get(`/api/programs/${NO_SUCH_ID}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toEqual(notMine.body.error);
  });

  it('lets only coordinators add, remove or list members', async () => {
    const { coordinator, program, volunteers, vols } = await setupProgram(1);
    const friend = await createUser('volunteer');
    const otherProgram = await createProgram(coordinator);

    const attempts = [
      await vols[0].post(`/api/programs/${program.id}/members`).send({ userId: friend.id }),
      await vols[0].post(`/api/programs/${otherProgram.id}/members`).send({ userId: volunteers[0].id }), // joining themselves
      await vols[0].delete(`/api/programs/${program.id}/members/${volunteers[0].id}`),
      await vols[0].get(`/api/programs/${program.id}/members`),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only coordinators can do that.' });
    }

    const { rows } = await pool.query('SELECT program_id, user_id FROM program_members WHERE program_id = ANY($1::int[])', [
      [program.id, otherProgram.id],
    ]);
    expect(rows).toEqual([{ program_id: program.id, user_id: volunteers[0].id }]);
  });

  it('adds only volunteers, and each only once', async () => {
    const { program, volunteers, coord } = await setupProgram(1);
    const colleague = await createUser('coordinator');

    const coordinatorTarget = await coord.post(`/api/programs/${program.id}/members`).send({ userId: colleague.id });
    expect(coordinatorTarget.status).toBe(400);
    expect(coordinatorTarget.body.error.code).toBe('VALIDATION_ERROR');
    expect(coordinatorTarget.body.error.message).toMatch(/Only volunteers can be added to a program/);

    const duplicate = await coord.post(`/api/programs/${program.id}/members`).send({ userId: volunteers[0].id });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({
      code: 'ALREADY_MEMBER',
      message: 'That volunteer is already a member of this program.',
    });

    expect((await coord.get(`/api/programs/${program.id}`)).body.program.memberCount).toBe(1);
  });

  it('reports an unknown volunteer or program, or a malformed volunteer id, clearly', async () => {
    const { program, volunteers, coord } = await setupProgram(1);

    const unknownVolunteer = await coord.post(`/api/programs/${program.id}/members`).send({ userId: NO_SUCH_ID });
    expect(unknownVolunteer.status).toBe(404);
    expect(unknownVolunteer.body.error.message).toBe('Volunteer not found.');

    const unknownProgram = await coord.post(`/api/programs/${NO_SUCH_ID}/members`).send({ userId: volunteers[0].id });
    expect(unknownProgram.status).toBe(404);
    expect(unknownProgram.body.error.message).toBe('Program not found.');

    for (const body of [{}, { userId: 'ana' }, { userId: -1 }]) {
      const res = await coord.post(`/api/programs/${program.id}/members`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(fieldsOf(res)).toEqual(['userId']);
    }
  });
});

describe('removing a member', () => {
  it("cancels their signups on this program's shifts that have not started, re-deriving each fill state", async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const [leaving, staying] = volunteers;
    const full = await insertShift(program.id, coordinator, { date: dayFromToday(5), requiredHeadcount: 2 });
    const partial = await insertShift(program.id, coordinator, { date: dayFromToday(6), requiredHeadcount: 3 });
    await vols[0].post(`/api/shifts/${full}/signups`);
    await vols[1].post(`/api/shifts/${full}/signups`);
    await vols[0].post(`/api/shifts/${partial}/signups`);
    expect((await shiftState(full)).state).toBe('filled');

    const res = await coord.delete(`/api/programs/${program.id}/members/${leaving.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelledSignups: 2 });

    expect(await shiftState(full)).toEqual({ state: 'partially_filled', signup_count: 1 });
    expect(await shiftState(partial)).toEqual({ state: 'open', signup_count: 0 });

    // Each timeline records the cancellation: who made it, whose signup it was, and why.
    const cancelled = {
      type: 'signup_cancelled',
      actor: { id: coordinator.id },
      volunteer: { id: leaving.id },
      details: { reason: 'removed_from_program' },
    };
    expect((await coord.get(`/api/shifts/${full}/timeline`)).body.events.slice(-2)).toMatchObject([
      cancelled,
      { type: 'state_changed', fromState: 'filled', toState: 'partially_filled', actor: { id: coordinator.id } },
    ]);
    expect((await coord.get(`/api/shifts/${partial}/timeline`)).body.events.slice(-2)).toMatchObject([
      cancelled,
      { type: 'state_changed', fromState: 'partially_filled', toState: 'open', actor: { id: coordinator.id } },
    ]);

    // The volunteer who stays keeps their spot.
    const detail = await coord.get(`/api/shifts/${full}`);
    expect(detail.body.signups.map((s: { volunteer: { id: number } }) => s.volunteer.id)).toEqual([staying.id]);
  });

  it('keeps their signups on shifts that have already started, and in their other programs', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const [volunteer] = volunteers;
    const otherProgram = await createProgram(coordinator);
    await addMember(otherProgram.id, volunteer, coordinator);
    const worked = await insertShift(program.id, coordinator, { date: dayFromToday(-3) });
    const workedSignup = await insertSignup(worked, volunteer);
    const elsewhere = await insertShift(otherProgram.id, coordinator, { date: dayFromToday(5) });
    const elsewhereSignup = (await vols[0].post(`/api/shifts/${elsewhere}/signups`)).body.signup.id;

    const res = await coord.delete(`/api/programs/${program.id}/members/${volunteer.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelledSignups: 0 });
    expect(await signupIsActive(workedSignup)).toBe(true);
    expect(await signupIsActive(elsewhereSignup)).toBe(true);
    expect(await shiftState(worked)).toEqual({ state: 'partially_filled', signup_count: 1 });

    // No longer a member: this program drops out of their view, the other one stays.
    expect(ids((await vols[0].get('/api/programs')).body.programs)).toEqual([otherProgram.id]);
    expect((await vols[0].get(`/api/programs/${program.id}`)).status).toBe(404);
    expect((await coord.get(`/api/programs/${program.id}/members`)).body.members).toEqual([]);
  });

  it('brings back a dismissed understaffing alert when the removal drops a Filled shift', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(2);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(1), requiredHeadcount: 2 });
    await vols[1].post(`/api/shifts/${shiftId}/signups`);
    expect((await coord.post(`/api/alerts/${shiftId}/dismiss`)).status).toBe(204);
    await vols[0].post(`/api/shifts/${shiftId}/signups`);
    expect((await shiftState(shiftId)).state).toBe('filled');

    await coord.delete(`/api/programs/${program.id}/members/${volunteers[0].id}`);
    const { alerts, dismissed } = (await coord.get('/api/alerts')).body;
    expect(alerts.map((s: ShiftView) => s.id)).toContain(shiftId);
    expect(dismissed.map((s: ShiftView) => s.id)).not.toContain(shiftId);
  });

  it('rejects removing someone who is not a member', async () => {
    const { program, coord } = await setupProgram(0);
    const stranger = await createUser('volunteer');
    const res = await coord.delete(`/api/programs/${program.id}/members/${stranger.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Membership not found.' });
  });

  it('lets a removed volunteer be added back and sign up again', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(4) });
    await vols[0].post(`/api/shifts/${shiftId}/signups`);
    await coord.delete(`/api/programs/${program.id}/members/${volunteers[0].id}`);

    expect((await coord.post(`/api/programs/${program.id}/members`).send({ userId: volunteers[0].id })).status).toBe(201);
    expect((await vols[0].post(`/api/shifts/${shiftId}/signups`)).status).toBe(201);
    expect(await shiftState(shiftId)).toEqual({ state: 'partially_filled', signup_count: 1 });
  });

  it('never leaves a removed volunteer holding a spot, even if they sign up at the same moment', async () => {
    const coordinator = await createUser('coordinator');
    const coord = await signIn(coordinator);
    for (let round = 0; round < 10; round += 1) {
      const program = await createProgram(coordinator);
      const volunteer = await createUser('volunteer');
      await addMember(program.id, volunteer, coordinator);
      const shiftId = await insertShift(program.id, coordinator, { date: dayFromToday(5) });
      const vol = await signIn(volunteer);

      const [removal, signup] = await Promise.all([
        coord.delete(`/api/programs/${program.id}/members/${volunteer.id}`),
        vol.post(`/api/shifts/${shiftId}/signups`),
      ]);
      expect(removal.status).toBe(200);
      // Either the signup landed first and the removal cancelled it, or the removal came first
      // and the signup was refused.
      expect([
        [201, 1],
        [404, 0],
      ]).toContainEqual([signup.status, removal.body.cancelledSignups]);
      expect(await shiftState(shiftId)).toEqual({ state: 'open', signup_count: 0 });
    }
  });
});

describe("a volunteer's own programs and shifts (GET /api/me/programs)", () => {
  it('lists exactly their active programs, each with every upcoming shift and their own signup on it', async () => {
    const coordinator = await createUser('coordinator');
    const volunteer = await createUser('volunteer');
    const teammate = await createUser('volunteer');
    const pantry = await createProgram(coordinator);
    const trail = await createProgram(coordinator);
    const archivedProgram = await createProgram(coordinator);
    const notMine = await createProgram(coordinator);
    for (const program of [pantry, trail, archivedProgram]) await addMember(program.id, volunteer, coordinator);
    await addMember(pantry.id, teammate, coordinator);
    await addMember(notMine.id, teammate, coordinator);

    const mine = await insertShift(pantry.id, coordinator, { date: dayFromToday(3) });
    const teammates = await insertShift(pantry.id, coordinator, { date: dayFromToday(4) });
    const past = await insertShift(pantry.id, coordinator, { date: dayFromToday(-3) });
    const deleted = await insertShift(pantry.id, coordinator, { date: dayFromToday(7) });
    const unclaimed = await insertShift(trail.id, coordinator, { date: dayFromToday(5) });
    const droppedOut = await insertShift(trail.id, coordinator, { date: dayFromToday(6) });
    await insertShift(archivedProgram.id, coordinator, { date: dayFromToday(3), startTime: '14:00' });
    await insertShift(notMine.id, coordinator, { date: dayFromToday(3), startTime: '18:00' });

    const vol = await signIn(volunteer);
    const coord = await signIn(coordinator);
    const mySignup = (await vol.post(`/api/shifts/${mine}/signups`)).body.signup.id;
    await insertSignup(teammates, teammate);
    await insertSignup(past, volunteer);
    const dropped = (await vol.post(`/api/shifts/${droppedOut}/signups`)).body.signup.id;
    expect((await vol.post(`/api/signups/${dropped}/cancel`)).status).toBe(204);
    expect((await coord.delete(`/api/shifts/${deleted}`)).status).toBe(200);
    expect((await coord.post(`/api/programs/${archivedProgram.id}/archive`)).status).toBe(200);

    const res = await vol.get('/api/me/programs');
    expect(res.status).toBe(200);
    expect(ids(res.body.programs)).toEqual(sorted([pantry.id, trail.id]));
    expect(shiftsIn(res.body.programs, pantry.id)).toEqual([
      [mine, mySignup],
      [teammates, null],
    ]);
    expect(shiftsIn(res.body.programs, trail.id)).toEqual([
      [unclaimed, null],
      [droppedOut, null],
    ]);
  });

  it('adds past shifts, closed ones included, when asked with includePast=true', async () => {
    const { coordinator, program, volunteers, vols, coord } = await setupProgram(1);
    const closed = await insertShift(program.id, coordinator, { date: dayFromToday(-5) });
    const worked = await insertSignup(closed, volunteers[0]);
    expect((await coord.post(`/api/shifts/${closed}/close`)).status).toBe(200);
    const lapsed = await insertShift(program.id, coordinator, { date: dayFromToday(-2) });
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(2) });

    for (const query of ['', '?includePast=false']) {
      const res = await vols[0].get(`/api/me/programs${query}`);
      expect(shiftsIn(res.body.programs, program.id), query).toEqual([[upcoming, null]]);
    }

    const withPast = await vols[0].get('/api/me/programs?includePast=true');
    expect(shiftsIn(withPast.body.programs, program.id)).toEqual([
      [closed, worked],
      [lapsed, null],
      [upcoming, null],
    ]);
    const shifts: ShiftView[] = withPast.body.programs.find((p: MyProgramView) => p.id === program.id).shifts;
    expect(shifts.find((s) => s.id === closed)?.state).toBe('closed');
  });

  it('keeps a shift that is under way in the list until it ends', async () => {
    const { coordinator, program, vols } = await setupProgram(1);
    const underway = await insertShift(program.id, coordinator, { ...startedMinutesAgo(60), durationMinutes: 180 });

    const res = await vols[0].get('/api/me/programs');
    expect(shiftsIn(res.body.programs, program.id)).toEqual([[underway, null]]);
    expect(res.body.programs[0].shifts[0]).toMatchObject({ hasStarted: true, hasEnded: false });
  });

  it('gives a volunteer with no programs an empty list, and accepts only true or false for includePast', async () => {
    const vol = await signIn(await createUser('volunteer'));
    const empty = await vol.get('/api/me/programs');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ programs: [] });

    const bad = await vol.get('/api/me/programs?includePast=yes');
    expect(bad.status).toBe(400);
    expect(fieldsOf(bad)).toEqual(['includePast']);

    expect((await request(app).get('/api/me/programs')).status).toBe(401);
  });
});
