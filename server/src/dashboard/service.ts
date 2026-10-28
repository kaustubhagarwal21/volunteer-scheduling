import type { AuthUser } from '../auth/types';
import { QueryParams } from '../db/params';
import { pool } from '../db/pool';
import { visibleProgramsSql } from '../programs/access';
import type { ShiftState } from '../shifts/dto';
import { addDays, orgClock, type OrgClock } from '../time/orgClock';

const WEEKS_CHARTED = 8;

type StateCounts = Record<ShiftState, number>;

export interface DashboardResponse {
  weekStart: string;
  weekEnd: string;
  headline: {
    shiftsThisWeek: number;
    openShiftsThisWeek: number;
    partiallyFilledThisWeek: number;
    signupsThisWeek: number;
    closedThisWeek: number;
  };
  /** All live shifts (not deleted, in active programs) by fill state. */
  byState: StateCounts;
  byProgram: ({ programId: number; name: string; total: number } & StateCounts)[];
  /** Oldest first; the last entry is the current week. */
  signupsPerWeek: { weekStart: string; signups: number }[];
}

const emptyCounts = (): StateCounts => ({ open: 0, partially_filled: 0, filled: 0, closed: 0 });

/**
 * The current organisation-local week (Monday to Sunday) as SQL fragments. Shift dates compare
 * with the dates; timestamptz columns (created_at, closed_at) compare with the instants.
 */
function thisWeek(params: QueryParams, clock: OrgClock) {
  const start = params.add(clock.weekStart);
  const zone = params.add(clock.timeZone);
  return {
    firstDay: `${start}::date`,
    lastDay: `(${start}::date + 6)`,
    startsAt: `(${start}::date::timestamp AT TIME ZONE ${zone})`,
    endsAt: `((${start}::date + 7)::timestamp AT TIME ZONE ${zone})`,
  };
}

/** Everything is scoped to what the viewer can see: all programs for coordinators, their own for volunteers. */
export async function getDashboard(user: AuthUser): Promise<DashboardResponse> {
  const clock = orgClock();
  const [shiftCounts, signupsThisWeek, programStates, signupsPerWeek] = await Promise.all([
    countShiftsThisWeek(user, clock),
    countSignupsThisWeek(user, clock),
    countByProgramAndState(user),
    countSignupsPerWeek(user, clock),
  ]);

  const byState = emptyCounts();
  const byProgram = new Map<number, DashboardResponse['byProgram'][number]>();
  for (const row of programStates) {
    const program = byProgram.get(row.program_id) ?? { programId: row.program_id, name: row.name, total: 0, ...emptyCounts() };
    if (row.state) {
      program[row.state] += row.shifts;
      program.total += row.shifts;
      byState[row.state] += row.shifts;
    }
    byProgram.set(row.program_id, program);
  }

  return {
    weekStart: clock.weekStart,
    weekEnd: addDays(clock.weekStart, 6),
    headline: {
      shiftsThisWeek: shiftCounts.shifts_this_week,
      openShiftsThisWeek: shiftCounts.open_this_week,
      partiallyFilledThisWeek: shiftCounts.partially_filled_this_week,
      signupsThisWeek,
      closedThisWeek: shiftCounts.closed_this_week,
    },
    byState,
    byProgram: [...byProgram.values()],
    signupsPerWeek,
  };
}

async function countShiftsThisWeek(user: AuthUser, clock: OrgClock) {
  const params = new QueryParams();
  const visible = visibleProgramsSql(user, params);
  const week = thisWeek(params, clock);
  const datedThisWeek = `s.shift_date BETWEEN ${week.firstDay} AND ${week.lastDay}`;
  const { rows } = await pool.query<{
    shifts_this_week: number;
    open_this_week: number;
    partially_filled_this_week: number;
    closed_this_week: number;
  }>(
    `SELECT count(*) FILTER (WHERE ${datedThisWeek}) AS shifts_this_week,
            count(*) FILTER (WHERE ${datedThisWeek} AND s.state = 'open') AS open_this_week,
            count(*) FILTER (WHERE ${datedThisWeek} AND s.state = 'partially_filled') AS partially_filled_this_week,
            count(*) FILTER (WHERE s.closed_at >= ${week.startsAt} AND s.closed_at < ${week.endsAt}) AS closed_this_week
       FROM shifts s
       JOIN programs p ON p.id = s.program_id
      WHERE s.deleted_at IS NULL AND p.archived_at IS NULL AND ${visible}`,
    params.values,
  );
  return rows[0];
}

/*
 * "Signups made" counts every signup created in the week, including ones cancelled later (or on
 * shifts deleted later). A signup was still made that week, and counting it this way means a
 * later cancellation never rewrites a past week's number.
 */
async function countSignupsThisWeek(user: AuthUser, clock: OrgClock): Promise<number> {
  const params = new QueryParams();
  const visible = visibleProgramsSql(user, params);
  const week = thisWeek(params, clock);
  const { rows } = await pool.query<{ signups: number }>(
    `SELECT count(*) AS signups
       FROM signups su
       JOIN shifts s ON s.id = su.shift_id
       JOIN programs p ON p.id = s.program_id
      WHERE p.archived_at IS NULL AND ${visible}
        AND su.created_at >= ${week.startsAt} AND su.created_at < ${week.endsAt}`,
    params.values,
  );
  return rows[0].signups;
}

async function countByProgramAndState(user: AuthUser) {
  const params = new QueryParams();
  const { rows } = await pool.query<{ program_id: number; name: string; state: ShiftState | null; shifts: number }>(
    `SELECT p.id AS program_id, p.name, s.state, count(s.id) AS shifts
       FROM programs p
       LEFT JOIN shifts s ON s.program_id = p.id AND s.deleted_at IS NULL
      WHERE p.archived_at IS NULL AND ${visibleProgramsSql(user, params)}
      GROUP BY p.id, p.name, s.state
      ORDER BY p.name`,
    params.values,
  );
  return rows;
}

/** Signups by the organisation-local week they were made in (same definition as above), oldest first. */
async function countSignupsPerWeek(user: AuthUser, clock: OrgClock) {
  const params = new QueryParams();
  const visible = visibleProgramsSql(user, params);
  const start = params.add(clock.weekStart);
  const zone = params.add(clock.timeZone);
  const { rows } = await pool.query<{ week_start: string; signups: number }>(
    `SELECT to_char(w.week_start, 'YYYY-MM-DD') AS week_start, count(su.id) AS signups
       FROM generate_series(${start}::date - ${(WEEKS_CHARTED - 1) * 7}, ${start}::date, interval '7 days') AS w(week_start)
       LEFT JOIN (signups su
                  JOIN shifts s ON s.id = su.shift_id
                  JOIN programs p ON p.id = s.program_id)
              ON p.archived_at IS NULL AND ${visible}
             AND su.created_at >= (w.week_start AT TIME ZONE ${zone})
             AND su.created_at < ((w.week_start + interval '7 days') AT TIME ZONE ${zone})
      GROUP BY w.week_start
      ORDER BY w.week_start`,
    params.values,
  );
  return rows.map((row) => ({ weekStart: row.week_start, signups: row.signups }));
}
