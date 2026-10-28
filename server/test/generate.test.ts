import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/types';
import { pool } from '../src/db/pool';
import {
  addMember,
  type Agent,
  createProgram,
  createUser,
  dayFromToday,
  eventsFor,
  insertShift,
  insertSignup,
  setupProgram,
  signIn,
  unique,
} from './helpers';

// --- Recurring schedule helpers ---------------------------------------------------------------

interface Pattern {
  startDate: string;
  endDate: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  location: string;
  requiredHeadcount: number;
  excludedDates?: string[];
}

/** Day of week of a 'YYYY-MM-DD' date in the API's convention: 0 = Sunday ... 6 = Saturday. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Date of the n-th weekly occurrence of `weeklyPattern` (n = 0 is tomorrow). */
function occurrence(n: number): string {
  return dayFromToday(1 + 7 * n);
}

/** Every week on tomorrow's weekday at 18:00, starting tomorrow and running for `weeks` weeks. */
function weeklyPattern(weeks: number, overrides: Partial<Pattern> = {}): Pattern {
  return {
    startDate: occurrence(0),
    endDate: occurrence(weeks - 1),
    dayOfWeek: weekdayOf(occurrence(0)),
    startTime: '18:00',
    durationMinutes: 120,
    location: 'Riverside Park',
    requiredHeadcount: 4,
    ...overrides,
  };
}

function generate(agent: Agent, programId: number, body: object) {
  return agent.post(`/api/programs/${programId}/shifts/generate`).send(body);
}

const datesOf = (shifts: { date: string }[]) => shifts.map((shift) => shift.date);

/** Dates of the program's live (not deleted) shifts, in order. */
async function liveShiftDates(programId: number): Promise<string[]> {
  const { rows } = await pool.query<{ date: string }>(
    'SELECT shift_date AS date FROM shifts WHERE program_id = $1 AND deleted_at IS NULL ORDER BY shift_date, start_time',
    [programId],
  );
  return rows.map((row) => row.date);
}

/** A 400 whose message and details both name the offending field. */
function expectFieldRejected(res: Response, field: string) {
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(res.body.error.message).toContain(`${field}:`);
  expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
}

// --- Roster helpers ---------------------------------------------------------------------------

const BOM = '﻿';
const ROSTER_HEADER = ['Volunteer', 'Email', 'Current member', 'Active signups', 'Total hours', 'Hours on closed shifts'];

/** Minimal RFC 4180 reader (quoted fields, doubled quotes, CRLF rows): reads the file the way a spreadsheet would. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

/** Downloads the roster and reads it back as one object per row, keyed by the header. */
async function downloadRoster(agent: Agent, programId: number) {
  const res = await agent.get(`/api/programs/${programId}/roster.csv`);
  expect(res.status).toBe(200);
  const text = res.text.startsWith(BOM) ? res.text.slice(BOM.length) : res.text;
  const [header, ...records] = parseCsv(text);
  expect(header).toEqual(ROSTER_HEADER);
  const rows = records.map((cells) => Object.fromEntries(header.map((column, i) => [column, cells[i]])));
  return { text, rows };
}

function rosterRow(volunteer: AuthUser, member: 'yes' | 'no', signups: number, totalHours: number, closedHours: number) {
  return {
    Volunteer: volunteer.name,
    Email: volunteer.email,
    'Current member': member,
    'Active signups': String(signups),
    'Total hours': String(totalHours),
    'Hours on closed shifts': String(closedHours),
  };
}

// --- Tests ------------------------------------------------------------------------------------

describe('generating a recurring schedule', () => {
  it('creates a shift on each matching weekday and reports every skipped date with its reason', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    // Week 1 already has a shift at the pattern's date and time; week 2 is excluded as a holiday.
    const existing = await insertShift(program.id, coordinator, {
      date: occurrence(1),
      startTime: '18:00',
      durationMinutes: 60,
      location: 'Old Hall',
      requiredHeadcount: 1,
    });

    const res = await generate(coord, program.id, weeklyPattern(5, { excludedDates: [occurrence(2)] }));

    expect(res.status).toBe(201);
    expect(datesOf(res.body.created)).toEqual([occurrence(0), occurrence(3), occurrence(4)]);
    for (const shift of res.body.created) {
      expect(shift).toMatchObject({
        programId: program.id,
        startTime: '18:00',
        endTime: '20:00',
        durationMinutes: 120,
        location: 'Riverside Park',
        requiredHeadcount: 4,
        signupCount: 0,
        spotsLeft: 4,
        state: 'open',
      });
    }
    expect(res.body.skipped).toEqual([
      { date: occurrence(1), reason: 'already_exists' },
      { date: occurrence(2), reason: 'holiday' },
    ]);
    expect(res.body.unusedExclusions).toEqual([]);

    // The shift that was already there is left exactly as it was.
    const { rows } = await pool.query(
      'SELECT location, duration_minutes, required_headcount FROM shifts WHERE id = $1',
      [existing],
    );
    expect(rows[0]).toEqual({ location: 'Old Hall', duration_minutes: 60, required_headcount: 1 });
    expect(await eventsFor(existing)).toHaveLength(1);
    expect(await liveShiftDates(program.id)).toEqual([occurrence(0), occurrence(1), occurrence(3), occurrence(4)]);
  });

  it('skips every date as already existing when the same pattern is run again', async () => {
    const { program, coord } = await setupProgram(0);
    const pattern = weeklyPattern(4);
    const dates = [0, 1, 2, 3].map(occurrence);
    expect(datesOf((await generate(coord, program.id, pattern)).body.created)).toEqual(dates);

    const again = await generate(coord, program.id, pattern);

    expect(again.status).toBe(201);
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toEqual(dates.map((date) => ({ date, reason: 'already_exists' })));
    expect(await liveShiftDates(program.id)).toEqual(dates);
  });

  it('only skips a date when this program already has a live shift at that same date and start time', async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const otherProgram = await createProgram(coordinator);
    // Same date, different start time.
    await insertShift(program.id, coordinator, { date: occurrence(0), startTime: '09:00' });
    // Same date and start time, but in another program.
    await insertShift(otherProgram.id, coordinator, { date: occurrence(1), startTime: '18:00' });
    // Same date and start time in this program, but deleted.
    const deleted = await insertShift(program.id, coordinator, { date: occurrence(2), startTime: '18:00' });
    expect((await coord.delete(`/api/shifts/${deleted}`)).status).toBe(200);

    const res = await generate(coord, program.id, weeklyPattern(3));

    expect(res.status).toBe(201);
    expect(datesOf(res.body.created)).toEqual([occurrence(0), occurrence(1), occurrence(2)]);
    expect(res.body.skipped).toEqual([]);
  });

  it('lists excluded dates that had no effect because they are off the weekday or outside the range', async () => {
    const { program, coord } = await setupProgram(0);
    const beforeRange = occurrence(-1);
    const offWeekday = dayFromToday(9); // inside the range, the day after occurrence(1)
    const afterRange = occurrence(4);

    const res = await generate(
      coord,
      program.id,
      weeklyPattern(4, { excludedDates: [afterRange, occurrence(1), offWeekday, beforeRange, occurrence(1)] }),
    );

    expect(res.status).toBe(201);
    expect(datesOf(res.body.created)).toEqual([occurrence(0), occurrence(2), occurrence(3)]);
    expect(res.body.skipped).toEqual([{ date: occurrence(1), reason: 'holiday' }]);
    expect(res.body.unusedExclusions).toEqual([beforeRange, offWeekday, afterRange]);
  });

  it("records a 'created' timeline entry marked as recurring on every new shift", async () => {
    const { coordinator, program, coord } = await setupProgram(0);
    const pattern = weeklyPattern(3, { startTime: '07:30', durationMinutes: 90, location: 'Library Annex', requiredHeadcount: 3 });

    const res = await generate(coord, program.id, pattern);
    expect(res.body.created).toHaveLength(3);

    for (const shift of res.body.created) {
      const timeline = await coord.get(`/api/shifts/${shift.id}/timeline`);
      expect(timeline.status).toBe(200);
      expect(timeline.body.events).toHaveLength(1);
      expect(timeline.body.events[0]).toMatchObject({
        type: 'created',
        actor: { id: coordinator.id, role: 'coordinator' },
        details: {
          source: 'recurring',
          date: shift.date,
          startTime: '07:30',
          durationMinutes: 90,
          location: 'Library Annex',
          requiredHeadcount: 3,
        },
      });
    }
  });

  it('creates each shift exactly once when two coordinators run the same pattern at the same moment', async () => {
    const { program, coord } = await setupProgram(0);
    const otherCoord = await signIn(await createUser('coordinator'));
    const pattern = weeklyPattern(6);
    const dates = [0, 1, 2, 3, 4, 5].map(occurrence);

    const results = await Promise.all([generate(coord, program.id, pattern), generate(otherCoord, program.id, pattern)]);

    expect(results.map((res) => res.status)).toEqual([201, 201]);
    expect(results.flatMap((res) => datesOf(res.body.created)).sort()).toEqual(dates);
    // Whatever one request created, the other reports as already existing.
    for (const res of results) {
      const created = new Set(datesOf(res.body.created));
      expect(res.body.skipped).toEqual(
        dates.filter((date) => !created.has(date)).map((date) => ({ date, reason: 'already_exists' })),
      );
    }
    expect(await liveShiftDates(program.id)).toEqual(dates);
  });

  it('refuses to add shifts to an archived program, and says how to fix it', async () => {
    const { program, coord } = await setupProgram(0);
    expect((await coord.post(`/api/programs/${program.id}/archive`)).status).toBe(200);

    const res = await generate(coord, program.id, weeklyPattern(2));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'PROGRAM_ARCHIVED',
      message: `${program.name} is archived. Restore the program first.`,
    });
    expect(await liveShiftDates(program.id)).toEqual([]);

    expect((await coord.post(`/api/programs/${program.id}/restore`)).status).toBe(200);
    expect((await generate(coord, program.id, weeklyPattern(2))).status).toBe(201);
  });

  it('lets only coordinators generate shifts, not volunteers of the program', async () => {
    const { program, vols } = await setupProgram(1);

    const res = await generate(vols[0], program.id, weeklyPattern(2));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only coordinators can do that.' });
    expect(await liveShiftDates(program.id)).toEqual([]);
  });
});

describe('generating a recurring schedule: invalid patterns are rejected with a reason', () => {
  it('rejects an end date before the start date', async () => {
    const { program, coord } = await setupProgram(0);

    const res = await generate(coord, program.id, weeklyPattern(1, { startDate: occurrence(1), endDate: occurrence(0) }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The end date must be on or after the start date.',
    });
    expect(await liveShiftDates(program.id)).toEqual([]);
  });

  it('rejects a range longer than 366 days', async () => {
    const { program, coord } = await setupProgram(0);

    const res = await generate(coord, program.id, weeklyPattern(1, { endDate: dayFromToday(1 + 400) }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'A pattern can cover at most 366 days at a time.',
    });
    expect(await liveShiftDates(program.id)).toEqual([]);
  });

  it('counts both the start and the end date toward the 366-day limit', async () => {
    const { program, coord } = await setupProgram(0);

    // Both ends are inclusive, so start..start+365 covers exactly 366 days: the longest allowed range.
    const longest = await generate(coord, program.id, weeklyPattern(1, { endDate: dayFromToday(1 + 365) }));
    expect(longest.status).toBe(201);

    // start..start+366 covers 367 days, one more than the limit the error message states.
    const oneDayTooLong = await generate(coord, program.id, weeklyPattern(1, { endDate: dayFromToday(1 + 366) }));
    expect(oneDayTooLong.status).toBe(400);
    expect(oneDayTooLong.body.error.message).toBe('A pattern can cover at most 366 days at a time.');
  });

  it('rejects a pattern whose first shift would already have started', async () => {
    const { program, coord } = await setupProgram(0);
    const today = dayFromToday(0);
    const lastWeek = dayFromToday(-7);
    const attempts = [
      // First occurrence is today, at a time that has already passed.
      weeklyPattern(1, { startDate: today, endDate: dayFromToday(7), dayOfWeek: weekdayOf(today), startTime: '00:00' }),
      // First occurrence was last week.
      weeklyPattern(1, { startDate: lastWeek, endDate: dayFromToday(14), dayOfWeek: weekdayOf(lastWeek) }),
    ];

    for (const pattern of attempts) {
      const res = await generate(coord, program.id, pattern);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'The first shift in this pattern would start in the past. Choose a later start date.',
      });
    }
    expect(await liveShiftDates(program.id)).toEqual([]);
  });

  it('judges "already started" by the first matching weekday, not by the start date', async () => {
    const { program, coord } = await setupProgram(0);
    const firstMatch = dayFromToday(2);

    const res = await generate(
      coord,
      program.id,
      weeklyPattern(1, { startDate: dayFromToday(-3), endDate: firstMatch, dayOfWeek: weekdayOf(firstMatch) }),
    );

    expect(res.status).toBe(201);
    expect(datesOf(res.body.created)).toEqual([firstMatch]);
  });

  it('rejects a day of week outside 0 (Sunday) to 6 (Saturday)', async () => {
    const { program, coord } = await setupProgram(0);

    for (const dayOfWeek of [7, -1, 2.5, '1']) {
      expectFieldRejected(await generate(coord, program.id, { ...weeklyPattern(2), dayOfWeek }), 'dayOfWeek');
    }
    expect(await liveShiftDates(program.id)).toEqual([]);
  });

  it('rejects a start time that is not HH:MM on the 24-hour clock', async () => {
    const { program, coord } = await setupProgram(0);

    for (const startTime of ['24:00', '9:00', '18:00:00', '6pm']) {
      const res = await generate(coord, program.id, weeklyPattern(2, { startTime }));
      expectFieldRejected(res, 'startTime');
      expect(res.body.error.message).toContain('Expected a time as HH:MM (24-hour)');
    }
    expect(await liveShiftDates(program.id)).toEqual([]);
  });

  it('rejects a fill state, or any field a weekly pattern does not have', async () => {
    const { program, coord } = await setupProgram(0);

    const withState = await generate(coord, program.id, { ...weeklyPattern(2), state: 'filled' });
    expect(withState.status).toBe(400);
    expect(withState.body.error.code).toBe('FILL_STATE_DERIVED');

    const withSingleDate = await generate(coord, program.id, { ...weeklyPattern(2), date: occurrence(0) });
    expect(withSingleDate.status).toBe(400);
    expect(withSingleDate.body.error.message).toMatch(/Unrecognized key.*"date"/);
    expect(await liveShiftDates(program.id)).toEqual([]);
  });

  it('reports a date the schedule cannot store as a validation error, not a server error', async () => {
    const { program, coord } = await setupProgram(0);
    // A one-digit typo: 3026 instead of 2026. The date is real, but beyond the years shifts can have.
    const startDate = '3026-11-02';

    const res = await generate(coord, program.id, {
      ...weeklyPattern(1),
      startDate,
      endDate: '3026-11-30',
      dayOfWeek: weekdayOf(startDate),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/date/i);
  });
});

describe('roster CSV export', () => {
  it('downloads as a CSV attachment named after the program and today, starting with a header row', async () => {
    const coordinator = await createUser('coordinator');
    const tag = unique();
    const program = await createProgram(coordinator, `Trail Cleanup, Saturdays ${tag}`);

    const res = await (await signIn(coordinator)).get(`/api/programs/${program.id}/roster.csv`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    // RFC 6266 allows the file name bare or quoted, so accept either.
    const fileName = /^attachment; filename="?([^";]+)"?$/.exec(res.headers['content-disposition'])?.[1];
    expect(fileName).toBe(`trail-cleanup-saturdays-${tag}-roster-${dayFromToday(0)}.csv`);
    // A byte-order mark so Excel reads UTF-8, then the header row, even before anyone has joined.
    expect(res.text).toBe(`${BOM}${ROSTER_HEADER.join(',')}\r\n`);
  });

  it('totals hours from active signups only, and counts closed shifts separately', async () => {
    const coordinator = await createUser('coordinator');
    const program = await createProgram(coordinator);
    const asha = await createUser('volunteer', 'Asha Rao');
    const ben = await createUser('volunteer', 'Ben Okafor');
    const cara = await createUser('volunteer', 'Cara Lima');
    for (const volunteer of [asha, ben, cara]) await addMember(program.id, volunteer, coordinator);
    const coord = await signIn(coordinator);
    const ashaAgent = await signIn(asha);
    const benAgent = await signIn(ben);

    // Worked and closed: 2 hours each for Asha and Ben. Cara didn't show, so the coordinator
    // cancelled her signup before closing the shift.
    const worked = await insertShift(program.id, coordinator, {
      date: dayFromToday(-3),
      startTime: '10:00',
      durationMinutes: 120,
      requiredHeadcount: 3,
    });
    await insertSignup(worked, asha);
    await insertSignup(worked, ben);
    const caraNoShow = await insertSignup(worked, cara);
    expect((await coord.post(`/api/signups/${caraNoShow}/cancel`)).status).toBe(204);
    expect((await coord.post(`/api/shifts/${worked}/close`)).status).toBe(200);

    // Over but not closed yet: 90 minutes for Asha.
    const notClosed = await insertShift(program.id, coordinator, {
      date: dayFromToday(-1),
      startTime: '14:00',
      durationMinutes: 90,
      requiredHeadcount: 3,
    });
    await insertSignup(notClosed, asha);

    // Upcoming: 50 minutes for Asha. Ben signed up, then cancelled.
    const upcoming = await insertShift(program.id, coordinator, {
      date: dayFromToday(6),
      startTime: '09:00',
      durationMinutes: 50,
      requiredHeadcount: 3,
    });
    expect((await ashaAgent.post(`/api/shifts/${upcoming}/signups`)).status).toBe(201);
    const benSignup = await benAgent.post(`/api/shifts/${upcoming}/signups`);
    expect((await benAgent.post(`/api/signups/${benSignup.body.signup.id}/cancel`)).status).toBe(204);

    const { rows } = await downloadRoster(coord, program.id);

    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        // 120 + 90 + 50 = 260 minutes = 4.33 hours, 2 of them on the closed shift.
        rosterRow(asha, 'yes', 3, 4.33, 2),
        rosterRow(ben, 'yes', 1, 2, 2),
        // Still a member, but her only signup was cancelled.
        rosterRow(cara, 'yes', 0, 0, 0),
      ]),
    );
  });

  it('includes a volunteer who left the program but has signups in it, marked as no longer a member', async () => {
    const coordinator = await createUser('coordinator');
    const program = await createProgram(coordinator);
    const stayer = await createUser('volunteer', 'Stays Member');
    const leaver = await createUser('volunteer', 'Left After Working');
    const leftEarly = await createUser('volunteer', 'Left Without Signups');
    for (const volunteer of [stayer, leaver, leftEarly]) await addMember(program.id, volunteer, coordinator);
    // Someone who only ever worked in a different program.
    const otherProgram = await createProgram(coordinator);
    const outsider = await createUser('volunteer', 'Other Program Only');
    await addMember(otherProgram.id, outsider, coordinator);
    await insertSignup(await insertShift(otherProgram.id, coordinator, { date: dayFromToday(-2) }), outsider);

    const coord = await signIn(coordinator);
    const worked = await insertShift(program.id, coordinator, { date: dayFromToday(-4), startTime: '08:00', durationMinutes: 180 });
    await insertSignup(worked, leaver);
    expect((await coord.post(`/api/shifts/${worked}/close`)).status).toBe(200);
    const upcoming = await insertShift(program.id, coordinator, { date: dayFromToday(4), durationMinutes: 60 });
    await insertSignup(upcoming, leaver);

    // Leaving cancels the upcoming signup but keeps the shift already worked.
    const removed = await coord.delete(`/api/programs/${program.id}/members/${leaver.id}`);
    expect(removed.body).toEqual({ cancelledSignups: 1 });
    expect((await coord.delete(`/api/programs/${program.id}/members/${leftEarly.id}`)).status).toBe(200);

    const { rows } = await downloadRoster(coord, program.id);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([rosterRow(leaver, 'no', 1, 3, 3), rosterRow(stayer, 'yes', 0, 0, 0)]));
  });

  it('quotes names containing commas or quotes, and neutralises names a spreadsheet would run as a formula', async () => {
    const coordinator = await createUser('coordinator');
    const program = await createProgram(coordinator);
    const comma = await createUser('volunteer', 'Rao, Asha');
    const quotes = await createUser('volunteer', 'Ben "Hammer" Okafor');
    const formula = await createUser('volunteer', '=HYPERLINK("http://evil.example","Click me")');
    const phone = await createUser('volunteer', '+91 98765 43210');
    for (const volunteer of [comma, quotes, formula, phone]) await addMember(program.id, volunteer, coordinator);

    const { text, rows } = await downloadRoster(await signIn(coordinator), program.id);

    const lines = text.split('\r\n');
    expect(lines).toContain(`"Rao, Asha",${comma.email},yes,0,0,0`);
    expect(lines).toContain(`"Ben ""Hammer"" Okafor",${quotes.email},yes,0,0,0`);
    // A leading apostrophe makes the spreadsheet show the text instead of running it.
    expect(lines).toContain(`"'=HYPERLINK(""http://evil.example"",""Click me"")",${formula.email},yes,0,0,0`);
    expect(lines).toContain(`'+91 98765 43210,${phone.email},yes,0,0,0`);
    // Read back as a spreadsheet would, no cell starts with a formula character.
    expect(rows.map((row) => row.Volunteer).sort()).toEqual(
      ["'+91 98765 43210", '\'=HYPERLINK("http://evil.example","Click me")', 'Ben "Hammer" Okafor', 'Rao, Asha'].sort(),
    );
  });

  it('is only available to coordinators', async () => {
    const { program, vols } = await setupProgram(1);

    const res = await vols[0].get(`/api/programs/${program.id}/roster.csv`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only coordinators can do that.' });
  });
});
