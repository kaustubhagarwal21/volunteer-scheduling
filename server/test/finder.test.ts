import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/types';
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

// Goal 6: one server-side list of shifts across every program the viewer can see, with search,
// filters, sorting and pagination. Other tests' shifts share this database, so every test builds
// its own programs and scopes its queries to them, by programId or by a search token only it uses.

type State = 'open' | 'partially_filled' | 'filled' | 'closed';

interface FoundShift {
  id: number;
  programId: number;
  programName: string;
  programArchived: boolean;
  date: string;
  startTime: string;
  location: string;
  state: State;
  deletedAt: string | null;
  mySignupId: number | null;
}

interface FinderPage {
  items: FoundShift[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type Query = Record<string, string | number | string[]>;

/** GET /api/shifts as `agent`; fails the test unless the server answers 200. */
async function find(agent: Agent, query: Query = {}): Promise<FinderPage> {
  const res = await agent.get('/api/shifts').query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as FinderPage;
}

const idsOf = (page: FinderPage) => page.items.map((shift) => shift.id);

/**
 * Text that appears in no other test's data, so searching for it only finds this test's shifts.
 * unique() never produces '~', so one token can't match inside a longer one.
 */
const token = () => `tok${unique()}~`;

type ShiftSpec = Parameters<typeof insertShift>[2];

/** Inserts the shifts one after another, so their ids follow the order given. */
async function addShifts(programId: number, coordinator: AuthUser, specs: ShiftSpec[]): Promise<number[]> {
  const ids: number[] = [];
  for (const spec of specs) ids.push(await insertShift(programId, coordinator, spec));
  return ids;
}

/** A signed-in coordinator and a fresh program of theirs. */
async function coordinatorWithProgram(programName?: string) {
  const coordinator = await createUser('coordinator');
  const program = await createProgram(coordinator, programName);
  return { coordinator, program, coord: await signIn(coordinator) };
}

/**
 * A program with one shift in each state. They are dated so that date order (Closed, Filled,
 * Partially filled, Open) is the reverse of lifecycle order, and alphabetical order is neither.
 */
async function programWithEveryState() {
  const { coordinator, program, coord } = await coordinatorWithProgram();
  const [open, partiallyFilled, filled, closed] = await addShifts(program.id, coordinator, [
    { date: dayFromToday(4) },
    { date: dayFromToday(3), requiredHeadcount: 2 },
    { date: dayFromToday(2), requiredHeadcount: 1 },
    { date: dayFromToday(-2) },
  ]);
  await insertSignup(partiallyFilled, await createUser('volunteer'));
  await insertSignup(filled, await createUser('volunteer'));
  expect((await coord.post(`/api/shifts/${closed}/close`)).status).toBe(200);
  const byState: Record<State, number> = { open, partially_filled: partiallyFilled, filled, closed };
  return { program, coord, byState };
}

describe('searching', () => {
  it('matches the text against program names and shift locations', async () => {
    const tok = token();
    const { coordinator, program: named, coord } = await coordinatorWithProgram(`Riverside Pantry ${tok}`);
    const other = await createProgram(coordinator);
    const [byName] = await addShifts(named.id, coordinator, [{ date: dayFromToday(3), location: 'Back door' }]);
    const [byLocation] = await addShifts(other.id, coordinator, [
      { date: dayFromToday(4), location: `Boathouse ${tok}` },
      { date: dayFromToday(5), location: 'Car park' },
    ]);

    const page = await find(coord, { q: tok });
    expect(idsOf(page)).toEqual([byName, byLocation]);
    expect(page.total).toBe(2);
  });

  it('ignores letter case and surrounding spaces', async () => {
    const tok = token();
    const { coordinator, program, coord } = await coordinatorWithProgram(`Riverside Pantry ${tok}`);
    const other = await createProgram(coordinator);
    const [byName] = await addShifts(program.id, coordinator, [{ date: dayFromToday(3) }]);
    const [byLocation] = await addShifts(other.id, coordinator, [{ date: dayFromToday(3), location: `Boathouse ${tok}` }]);

    expect(idsOf(await find(coord, { q: `  riverside PANTRY ${tok.toUpperCase()}  ` }))).toEqual([byName]);
    expect(idsOf(await find(coord, { q: `BOATHOUSE ${tok.toUpperCase()}` }))).toEqual([byLocation]);
  });

  it('treats %, _ and \\ in the search text as plain characters, not wildcards', async () => {
    const { coordinator, program, coord } = await coordinatorWithProgram();
    const locations = ['Hall 50% off', 'Hall 500 off', 'Room A_1', 'Room AB1', 'Shed C\\D', 'Shed CD'];
    const [percent, , underscore, , backslash] = await addShifts(
      program.id,
      coordinator,
      locations.map((location, i) => ({ date: dayFromToday(i + 1), location })),
    );
    const search = async (q: string) => idsOf(await find(coord, { programId: program.id, q }));

    expect(await search('50%')).toEqual([percent]); // as a wildcard, % would also match "500"
    expect(await search('%')).toEqual([percent]); // ...and a lone % would match every shift
    expect(await search('A_1')).toEqual([underscore]); // as a wildcard, _ would also match "AB1"
    expect(await search('_')).toEqual([underscore]);
    expect(await search('C\\D')).toEqual([backslash]); // as an escape, \ would match "CD" instead
  });

  it('returns an empty first page when nothing matches', async () => {
    const { coord } = await coordinatorWithProgram();
    expect(await find(coord, { q: token() })).toMatchObject({ items: [], total: 0, page: 1 });
  });
});

describe('filtering', () => {
  it('filters by program', async () => {
    const tok = token();
    const { coordinator, program: pantry, coord } = await coordinatorWithProgram();
    const trail = await createProgram(coordinator);
    const [pantryShift] = await addShifts(pantry.id, coordinator, [{ date: dayFromToday(2), location: `Hall ${tok}` }]);
    const [trailShift] = await addShifts(trail.id, coordinator, [{ date: dayFromToday(2), location: `Hall ${tok}` }]);

    expect(idsOf(await find(coord, { q: tok }))).toEqual([pantryShift, trailShift]);
    const page = await find(coord, { q: tok, programId: trail.id });
    expect(idsOf(page)).toEqual([trailShift]);
    expect(page.items[0]).toMatchObject({ programId: trail.id, programName: trail.name });
  });

  it('filters by each fill state', async () => {
    const { program, coord, byState } = await programWithEveryState();
    for (const [state, shiftId] of Object.entries(byState)) {
      const page = await find(coord, { programId: program.id, state });
      expect(page.items.map((shift) => [shift.id, shift.state]), state).toEqual([[shiftId, state]]);
    }
  });

  it('filters by date, counting both dateFrom and dateTo as inside the range', async () => {
    const { coordinator, program, coord } = await coordinatorWithProgram();
    // A shift at midnight and one late in the evening: the range must cover whole days, not instants.
    const [day1, day2, day3, day4] = await addShifts(program.id, coordinator, [
      { date: dayFromToday(1) },
      { date: dayFromToday(2), startTime: '00:00' },
      { date: dayFromToday(3), startTime: '23:00', durationMinutes: 60 },
      { date: dayFromToday(4) },
    ]);
    const between = async (range: Query) => idsOf(await find(coord, { programId: program.id, ...range }));

    expect(await between({ dateFrom: dayFromToday(2), dateTo: dayFromToday(3) })).toEqual([day2, day3]);
    expect(await between({ dateFrom: dayFromToday(3) })).toEqual([day3, day4]);
    expect(await between({ dateTo: dayFromToday(2) })).toEqual([day1, day2]);
    expect(await between({ dateFrom: dayFromToday(4), dateTo: dayFromToday(4) })).toEqual([day4]);
  });

  it('applies search, program, fill state and date filters together', async () => {
    const tok = token();
    const { coordinator, program, coord } = await coordinatorWithProgram(`Pantry ${tok}`);
    const annex = await createProgram(coordinator, `Pantry annex ${tok}`);
    // Every shift matches the search; each one but `match` fails exactly one other filter.
    const [match, filled] = await addShifts(program.id, coordinator, [
      { date: dayFromToday(2), startTime: '09:00' },
      { date: dayFromToday(2), startTime: '13:00', requiredHeadcount: 1 }, // wrong state
      { date: dayFromToday(6) }, // after dateTo
    ]);
    await insertSignup(filled, await createUser('volunteer'));
    await addShifts(annex.id, coordinator, [{ date: dayFromToday(2) }]); // wrong program

    const page = await find(coord, { q: tok, programId: program.id, state: 'open', dateTo: dayFromToday(3) });
    expect(idsOf(page)).toEqual([match]);
    expect(page.total).toBe(1);
  });
});

describe('sorting', () => {
  // Five shifts whose date order, time-of-day order and creation order all differ.
  async function fiveShifts() {
    const { coordinator, program, coord } = await coordinatorWithProgram();
    const [a, b, c, d, e] = await addShifts(program.id, coordinator, [
      { date: dayFromToday(3), startTime: '08:00' },
      { date: dayFromToday(1), startTime: '14:00' },
      { date: dayFromToday(2), startTime: '09:00' },
      { date: dayFromToday(1), startTime: '07:00' },
      { date: dayFromToday(2), startTime: '07:00' },
    ]);
    const sorted = async (query: Query) => idsOf(await find(coord, { programId: program.id, ...query }));
    return { a, b, c, d, e, sorted };
  }

  it('sorts by date then start time, earliest first by default', async () => {
    const { a, b, c, d, e, sorted } = await fiveShifts();
    const chronological = [d, b, e, c, a];
    expect(await sorted({})).toEqual(chronological);
    expect(await sorted({ sort: 'date', order: 'asc' })).toEqual(chronological);
    expect(await sorted({ sort: 'date', order: 'desc' })).toEqual([...chronological].reverse());
  });

  it('sorts by start time of day, then by date', async () => {
    const { a, b, c, d, e, sorted } = await fiveShifts();
    const byTimeOfDay = [d, e, a, c, b]; // 07:00 day 1, 07:00 day 2, 08:00, 09:00, 14:00
    expect(await sorted({ sort: 'start_time' })).toEqual(byTimeOfDay);
    expect(await sorted({ sort: 'start_time', order: 'desc' })).toEqual([...byTimeOfDay].reverse());
  });

  it('sorts by fill state in lifecycle order: Open, Partially filled, Filled, Closed', async () => {
    const { program, coord } = await programWithEveryState();
    const states = async (order: string) =>
      (await find(coord, { programId: program.id, sort: 'state', order })).items.map((shift) => shift.state);

    expect(await states('asc')).toEqual(['open', 'partially_filled', 'filled', 'closed']);
    expect(await states('desc')).toEqual(['closed', 'filled', 'partially_filled', 'open']);
  });

  it('orders tied shifts the same way every time, so paging never repeats or skips one', async () => {
    const tok = token();
    const coordinator = await createUser('coordinator');
    const coord = await signIn(coordinator);
    // Three programs with shifts at identical dates and times, all Open: every sort key ties.
    const shiftIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const program = await createProgram(coordinator);
      shiftIds.push(
        ...(await addShifts(program.id, coordinator, [
          { date: dayFromToday(5), location: `Hall ${tok}` },
          { date: dayFromToday(6), location: `Hall ${tok}` },
        ])),
      );
    }

    for (const sort of ['date', 'start_time', 'state']) {
      for (const order of ['asc', 'desc']) {
        const whole = idsOf(await find(coord, { q: tok, sort, order, pageSize: 100 }));
        const pageByPage: number[] = [];
        for (let page = 1; page <= shiftIds.length; page += 1) {
          pageByPage.push(...idsOf(await find(coord, { q: tok, sort, order, pageSize: 1, page })));
        }
        expect(pageByPage, `${sort} ${order}`).toEqual(whole);
        expect([...whole].sort((x, y) => x - y), `${sort} ${order}`).toEqual(shiftIds);
      }
    }
  });
});

describe('pagination', () => {
  it('splits the matches into pages and reports the total number of matches and pages', async () => {
    const { coordinator, program, coord } = await coordinatorWithProgram();
    const shiftIds = await addShifts(program.id, coordinator, [1, 2, 3, 4, 5].map((n) => ({ date: dayFromToday(n) })));
    const page = (n: number) => find(coord, { programId: program.id, pageSize: 2, page: n });

    const first = await page(1);
    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2, totalPages: 3 });
    expect(idsOf(first)).toEqual(shiftIds.slice(0, 2));
    expect(idsOf(await page(2))).toEqual(shiftIds.slice(2, 4));
    const last = await page(3);
    expect(last).toMatchObject({ total: 5, page: 3, totalPages: 3 });
    expect(idsOf(last)).toEqual(shiftIds.slice(4));

    // Past the end there are no rows, but the client is still told how many matches exist.
    expect(await page(4)).toMatchObject({ items: [], total: 5, page: 4, totalPages: 3 });
  });

  it('shows the first 20 matches when no page is asked for', async () => {
    const { coordinator, program, coord } = await coordinatorWithProgram();
    const shiftIds = await addShifts(
      program.id,
      coordinator,
      Array.from({ length: 21 }, (_, n) => ({ date: dayFromToday(n + 1) })),
    );

    const firstPage = await find(coord, { programId: program.id });
    expect(firstPage).toMatchObject({ total: 21, page: 1, pageSize: 20, totalPages: 2 });
    expect(idsOf(firstPage)).toEqual(shiftIds.slice(0, 20));
  });
});

describe('who sees which shifts', () => {
  it('requires sign-in', async () => {
    const res = await request(app).get('/api/shifts');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('shows a volunteer the shifts of every program they belong to, and no others', async () => {
    const tok = token();
    const { coordinator, program: pantry, coord } = await coordinatorWithProgram();
    const trail = await createProgram(coordinator);
    const tutoring = await createProgram(coordinator);
    const volunteer = await createUser('volunteer');
    await addMember(pantry.id, volunteer, coordinator);
    await addMember(trail.id, volunteer, coordinator);
    const [pantryShift] = await addShifts(pantry.id, coordinator, [{ date: dayFromToday(2), location: `Hall ${tok}` }]);
    const [trailShift] = await addShifts(trail.id, coordinator, [{ date: dayFromToday(2), location: `Hall ${tok}` }]);
    const [tutoringShift] = await addShifts(tutoring.id, coordinator, [{ date: dayFromToday(2), location: `Hall ${tok}` }]);
    const vol = await signIn(volunteer);

    const page = await find(vol, { q: tok });
    expect(idsOf(page)).toEqual([pantryShift, trailShift]);
    expect(page.total).toBe(2);
    // Naming the other program's id reveals nothing either.
    expect(await find(vol, { programId: tutoring.id })).toMatchObject({ items: [], total: 0 });
    // A volunteer who belongs to no program sees no shifts at all.
    expect(await find(await signIn(await createUser('volunteer')))).toMatchObject({ items: [], total: 0 });
    // Coordinators see every program.
    expect(idsOf(await find(coord, { q: tok }))).toEqual([pantryShift, trailShift, tutoringShift]);
  });

  it('leaves out archived programs, unless a coordinator filters by that program', async () => {
    const tok = token();
    const { coordinator, program: archived, coord } = await coordinatorWithProgram();
    const active = await createProgram(coordinator);
    const volunteer = await createUser('volunteer');
    await addMember(archived.id, volunteer, coordinator);
    await addMember(active.id, volunteer, coordinator);
    const [archivedShift] = await addShifts(archived.id, coordinator, [{ date: dayFromToday(3), location: `Hall ${tok}` }]);
    const [activeShift] = await addShifts(active.id, coordinator, [{ date: dayFromToday(3), location: `Hall ${tok}` }]);
    expect((await coord.post(`/api/programs/${archived.id}/archive`)).status).toBe(200);
    const vol = await signIn(volunteer);

    expect(idsOf(await find(coord, { q: tok }))).toEqual([activeShift]);
    expect(idsOf(await find(vol, { q: tok }))).toEqual([activeShift]);

    const opened = await find(coord, { programId: archived.id });
    expect(idsOf(opened)).toEqual([archivedShift]);
    expect(opened.items[0].programArchived).toBe(true);
    // Being a member doesn't let a volunteer open an archived program this way.
    expect(await find(vol, { programId: archived.id })).toMatchObject({ items: [], total: 0 });

    // Archiving only hid the shift: restoring the program brings it back.
    expect((await coord.post(`/api/programs/${archived.id}/restore`)).status).toBe(200);
    expect(idsOf(await find(vol, { q: tok }))).toEqual([archivedShift, activeShift]);
  });

  it('leaves out deleted shifts, but a coordinator can list them with deleted=only', async () => {
    const tok = token();
    const { coordinator, program, coord } = await coordinatorWithProgram();
    const [kept, deleted] = await addShifts(program.id, coordinator, [
      { date: dayFromToday(3), location: `Hall ${tok}` },
      { date: dayFromToday(4), location: `Hall ${tok}` },
    ]);
    expect((await coord.delete(`/api/shifts/${deleted}`)).status).toBe(200);

    expect(idsOf(await find(coord, { q: tok }))).toEqual([kept]);
    expect(idsOf(await find(coord, { q: tok, deleted: 'exclude' }))).toEqual([kept]);
    const deletedOnly = await find(coord, { q: tok, deleted: 'only' });
    expect(idsOf(deletedOnly)).toEqual([deleted]);
    expect(deletedOnly.total).toBe(1);
    expect(deletedOnly.items[0].deletedAt).not.toBeNull();
  });

  it('never lists a deleted shift for a volunteer, even when they ask with deleted=only', async () => {
    const tok = token();
    const { coordinator, program, coord } = await coordinatorWithProgram();
    const volunteer = await createUser('volunteer');
    await addMember(program.id, volunteer, coordinator);
    const [, deleted] = await addShifts(program.id, coordinator, [
      { date: dayFromToday(3), location: `Hall ${tok}` },
      { date: dayFromToday(4), location: `Hall ${tok}` },
    ]);
    expect((await coord.delete(`/api/shifts/${deleted}`)).status).toBe(200);
    const vol = await signIn(volunteer);

    for (const deletedParam of ['exclude', 'only']) {
      const page = await find(vol, { q: tok, deleted: deletedParam });
      expect(idsOf(page), deletedParam).not.toContain(deleted);
      expect(page.items.every((shift) => shift.deletedAt === null), deletedParam).toBe(true);
    }
  });

  it('marks which listed shifts the viewer is signed up for', async () => {
    const tok = token();
    const coordinator = await createUser('coordinator');
    const program = await createProgram(coordinator);
    const [volunteer, other] = [await createUser('volunteer'), await createUser('volunteer')];
    await addMember(program.id, volunteer, coordinator);
    await addMember(program.id, other, coordinator);
    const [taken, free] = await addShifts(program.id, coordinator, [
      { date: dayFromToday(3), location: `Hall ${tok}` },
      { date: dayFromToday(4), location: `Hall ${tok}` },
    ]);
    const vol = await signIn(volunteer);
    const signup = await vol.post(`/api/shifts/${taken}/signups`);
    expect(signup.status).toBe(201);

    const mine = await find(vol, { q: tok });
    expect(mine.items.map((shift) => [shift.id, shift.mySignupId])).toEqual([
      [taken, signup.body.signup.id],
      [free, null],
    ]);
    const theirs = await find(await signIn(other), { q: tok });
    expect(theirs.items.map((shift) => [shift.id, shift.mySignupId])).toEqual([
      [taken, null],
      [free, null],
    ]);
  });
});

describe('invalid parameters', () => {
  async function expectRejected(query: Query, why: RegExp) {
    const coord = await signIn(await createUser('coordinator'));
    const res = await coord.get('/api/shifts').query(query);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(why);
  }

  it.each<[string, Query, RegExp]>([
    ['an impossible date', { dateFrom: '2026-02-30' }, /dateFrom: .*date/i],
    ['a date not written as YYYY-MM-DD', { dateTo: '28/10/2026' }, /dateTo: .*date/i],
    ['a range that ends before it starts', { dateFrom: '2026-11-05', dateTo: '2026-11-01' }, /dateFrom must be on or before dateTo/],
    ['a page size over 100', { pageSize: 101 }, /pageSize: .*100/],
    ['a page size of 0', { pageSize: 0 }, /pageSize: /],
    ['page 0', { page: 0 }, /\bpage: /],
    ['a fractional page', { page: 1.5 }, /\bpage: /],
    ['an unknown fill state', { state: 'full' }, /state: /],
    ['an unknown sort', { sort: 'location' }, /sort: /],
    ['an unknown sort order', { order: 'sideways' }, /order: /],
    ['a program id that is not a number', { programId: 'pantry' }, /programId: /],
    ['a search longer than 100 characters', { q: 'x'.repeat(101) }, /\bq: .*100/],
    ['the same parameter twice', { q: ['pantry', 'trail'] }, /\bq: /],
    ['an unknown parameter', { colour: 'red' }, /Unrecognized key.*colour/i],
  ])('rejects %s with a 400 that says what is wrong', async (_case, query, why) => {
    await expectRejected(query, why);
  });

  // These get past the schema but are values Postgres itself refuses, so unless the server catches
  // them first the query fails and the client gets a 500 with no explanation.
  it.each<[string, Query, RegExp]>([
    ['the year 0000 as a date', { dateFrom: '0000-01-01' }, /dateFrom/],
    ['a NUL character in the search text', { q: 'pantry\u0000' }, /\bq\b/],
  ])('rejects %s with a 400, not a server error', async (_case, query, why) => {
    await expectRejected(query, why);
  });
});
