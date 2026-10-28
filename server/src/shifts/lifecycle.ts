import type { PoolClient } from 'pg';
import { conflict, notFound } from '../http/errors';
import { recordEvent } from '../timeline/events';
import { SHIFT_COLUMNS, type ShiftRow, type ShiftState } from './dto';

/*
 * Locking rules for every transaction that changes signups or shift state. Always acquire in this
 * order, so two transactions can never wait on each other in a cycle (a deadlock):
 *
 *   1. the program row        FOR SHARE (FOR UPDATE when archiving)
 *   2. the membership row     FOR KEY SHARE when signing someone up; DELETE when removing them
 *   3. shift rows             FOR UPDATE, in ascending id order
 *   4. volunteer schedules    advisory locks, in ascending user id order
 *   5. signup rows
 */

/** A shift row loaded with FOR UPDATE: nobody else can change it until our transaction ends. */
export interface LockedShift extends ShiftRow {
  /** Raw tsrange text, copied onto signups for the overlap constraint. */
  time_range: string;
}

/**
 * Lock 1: the program a shift belongs to, FOR SHARE. Concurrent shift operations can all hold it;
 * archiving takes FOR UPDATE and so waits for them (and they wait for an archive in progress).
 */
export async function lockProgramOfShift(
  tx: PoolClient,
  shiftId: number,
): Promise<{ id: number; name: string; archived: boolean }> {
  const { rows } = await tx.query<{ id: number; name: string; archived: boolean }>(
    `SELECT p.id, p.name, p.archived_at IS NOT NULL AS archived
       FROM programs p
      WHERE p.id = (SELECT program_id FROM shifts WHERE id = $1 AND deleted_at IS NULL)
        FOR SHARE`,
    [shiftId],
  );
  if (!rows[0]) throw notFound('Shift');
  return rows[0];
}

/**
 * Lock 3: loads a live (not deleted) shift and locks its row for the rest of the transaction.
 * Every operation that changes a shift's signups or state goes through here, so two requests for
 * the same shift — e.g. two volunteers claiming the last spot — run one after the other instead of
 * both reading the same count.
 */
export async function lockShift(tx: PoolClient, shiftId: number): Promise<LockedShift> {
  const { rows } = await tx.query<LockedShift>(
    `SELECT ${SHIFT_COLUMNS}, s.time_range::text AS time_range
       FROM shifts s
       JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND s.deleted_at IS NULL
        FOR UPDATE OF s`,
    [shiftId],
  );
  if (!rows[0]) throw notFound('Shift');
  return rows[0];
}

// First half of the two-key advisory lock id that means "this volunteer's schedule"; the second
// half is the user id.
const VOLUNTEER_SCHEDULE_LOCK = 1;

/**
 * Lock 4: makes concurrent changes to the same volunteer's signups run one at a time.
 *
 * The EXCLUDE constraint on signups is what guarantees no double-booking. But when two transactions
 * insert overlapping rows for one volunteer at the same instant, each sees the other's uncommitted
 * row and waits for it; Postgres breaks the deadlock by failing one with an error. Holding this lock
 * first makes the second request wait instead, then see the first signup and get a clear 409.
 * Advisory locks taken with pg_advisory_xact_lock are released automatically at COMMIT or ROLLBACK.
 */
export async function lockVolunteerSchedules(tx: PoolClient, volunteerIds: number[]): Promise<void> {
  for (const id of [...new Set(volunteerIds)].sort((a, b) => a - b)) {
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [VOLUNTEER_SCHEDULE_LOCK, id]);
  }
}

/** Archived programs are frozen: readable, but nothing about them changes until restored. */
export function assertProgramActive(shift: Pick<ShiftRow, 'program_archived' | 'program_name'>): void {
  if (shift.program_archived) {
    throw conflict(
      'PROGRAM_ARCHIVED',
      `${shift.program_name} is archived. Restore the program before changing its shifts or signups.`,
    );
  }
}

/**
 * Moves signup_count by one. Postgres re-derives `state` from the new count (it is a generated
 * column), the CHECK constraint refuses a count above the required headcount, and a deferred
 * trigger verifies at commit that the count matches the active signups.
 * Also updates the in-memory locked row, so a caller can adjust the same shift more than once.
 */
export async function adjustSignupCount(
  tx: PoolClient,
  shift: LockedShift,
  delta: 1 | -1,
  actorId: number,
): Promise<ShiftState> {
  const { rows } = await tx.query<{ state: ShiftState }>(
    'UPDATE shifts SET signup_count = signup_count + $2, updated_at = now() WHERE id = $1 RETURNING state',
    [shift.id, delta],
  );
  const newState = rows[0].state;
  await recordStateChange(tx, shift, newState, actorId);
  shift.state = newState;
  shift.signup_count += delta;
  return newState;
}

/**
 * Writes a fill-state change to the timeline with the old and new state. Every path that can change
 * the state (signup, cancellation, headcount edit, closing, deletion) calls this with the state it
 * read under the row lock and the state Postgres returned after the write.
 */
export async function recordStateChange(
  tx: PoolClient,
  shift: Pick<ShiftRow, 'id' | 'state'>,
  newState: ShiftState,
  actorId: number,
): Promise<void> {
  if (newState === shift.state) return;
  await recordEvent(tx, { shiftId: shift.id, type: 'state_changed', actorId, fromState: shift.state, toState: newState });
}

/** '2026-11-07 09:00–12:00' for use in error messages. */
export function describeWindow(shift: Pick<ShiftRow, 'date' | 'start_time' | 'ends_at'>): string {
  const endDate = shift.ends_at.slice(0, 10);
  const end = shift.ends_at.slice(11, 16);
  return `${shift.date} ${shift.start_time}–${endDate === shift.date ? end : `${endDate} ${end}`}`;
}
