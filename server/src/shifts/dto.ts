import type { OrgClock } from '../time/orgClock';

export type ShiftState = 'open' | 'partially_filled' | 'filled' | 'closed';

/**
 * Columns every shift query selects. Use with `FROM shifts s JOIN programs p ON p.id = s.program_id`.
 * starts_at / ends_at are organisation-local wall-clock strings, so they compare directly with
 * OrgClock.now (fixed-width 'YYYY-MM-DD HH:MM:SS' strings sort chronologically).
 */
export const SHIFT_COLUMNS = `
  s.id,
  s.program_id,
  p.name AS program_name,
  p.archived_at IS NOT NULL AS program_archived,
  s.shift_date AS date,
  to_char(s.start_time, 'HH24:MI') AS start_time,
  s.duration_minutes,
  to_char(lower(s.time_range), 'YYYY-MM-DD HH24:MI:SS') AS starts_at,
  to_char(upper(s.time_range), 'YYYY-MM-DD HH24:MI:SS') AS ends_at,
  s.location,
  s.required_headcount,
  s.signup_count,
  s.state,
  s.closed_at,
  s.deleted_at`;

export interface ShiftRow {
  id: number;
  program_id: number;
  program_name: string;
  program_archived: boolean;
  date: string;
  start_time: string;
  duration_minutes: number;
  starts_at: string;
  ends_at: string;
  location: string;
  required_headcount: number;
  signup_count: number;
  state: ShiftState;
  closed_at: Date | null;
  deleted_at: Date | null;
}

export interface ShiftDto {
  id: number;
  programId: number;
  programName: string;
  programArchived: boolean;
  date: string;
  startTime: string;
  endTime: string;
  /** Set when the shift ends on a later date than it starts (crosses midnight). */
  endDate: string | null;
  durationMinutes: number;
  location: string;
  requiredHeadcount: number;
  signupCount: number;
  spotsLeft: number;
  state: ShiftState;
  hasStarted: boolean;
  hasEnded: boolean;
  closedAt: string | null;
  /** Only ever non-null for coordinators, who can still open deleted shifts to read their history. */
  deletedAt: string | null;
}

export const hasStarted = (row: Pick<ShiftRow, 'starts_at'>, clock: OrgClock) => row.starts_at <= clock.now;
export const hasEnded = (row: Pick<ShiftRow, 'ends_at'>, clock: OrgClock) => row.ends_at <= clock.now;

export function toShiftDto(row: ShiftRow, clock: OrgClock): ShiftDto {
  const endDate = row.ends_at.slice(0, 10);
  return {
    id: row.id,
    programId: row.program_id,
    programName: row.program_name,
    programArchived: row.program_archived,
    date: row.date,
    startTime: row.start_time,
    endTime: row.ends_at.slice(11, 16),
    endDate: endDate === row.date ? null : endDate,
    durationMinutes: row.duration_minutes,
    location: row.location,
    requiredHeadcount: row.required_headcount,
    signupCount: row.signup_count,
    spotsLeft: row.required_headcount - row.signup_count,
    state: row.state,
    hasStarted: hasStarted(row, clock),
    hasEnded: hasEnded(row, clock),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
  };
}
