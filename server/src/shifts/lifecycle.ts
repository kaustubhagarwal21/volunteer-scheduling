import type { PoolClient } from 'pg';
import { conflict, notFound } from '../http/errors';
import { recordEvent } from '../timeline/events';
import { SHIFT_COLUMNS, type ShiftRow, type ShiftState } from './dto';

/** A shift row loaded with FOR UPDATE: nobody else can change it until our transaction ends. */
export interface LockedShift extends ShiftRow {
  /** Raw tsrange text, copied onto signups for the overlap constraint. */
  time_range: string;
}

/**
 * Loads a live (not deleted) shift and locks its row for the rest of the transaction.
 * Every operation that changes a shift's signups or state starts here, so two requests for the
 * same shift — e.g. two volunteers claiming the last spot — run one after the other instead of
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
 * column), and the CHECK constraint refuses a count above the required headcount.
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
  await onStateChanged(tx, shift, newState, actorId);
  shift.state = newState;
  shift.signup_count += delta;
  return newState;
}

/**
 * Everything that must happen when a shift's fill state changes, whatever caused it
 * (signup, cancellation, headcount edit, closing):
 *  - the change is written to the timeline with the old and new state;
 *  - if a Filled shift drops back to Open / Partially Filled, any dismissed understaffing alert is
 *    un-dismissed, so the alert returns while the shift is within the alert window (goal 10).
 */
export async function onStateChanged(
  tx: PoolClient,
  shift: Pick<ShiftRow, 'id' | 'state'>,
  newState: ShiftState,
  actorId: number,
): Promise<void> {
  if (newState === shift.state) return;

  await recordEvent(tx, { shiftId: shift.id, type: 'state_changed', actorId, fromState: shift.state, toState: newState });

  const droppedOutOfFilled = shift.state === 'filled' && (newState === 'open' || newState === 'partially_filled');
  if (droppedOutOfFilled) {
    await tx.query('UPDATE shifts SET alert_dismissed_at = NULL, alert_dismissed_by = NULL WHERE id = $1', [shift.id]);
  }
}

/** '2026-11-07 09:00–12:00' for use in error messages. */
export function describeWindow(shift: Pick<ShiftRow, 'date' | 'start_time' | 'ends_at'>): string {
  const endDate = shift.ends_at.slice(0, 10);
  const end = shift.ends_at.slice(11, 16);
  return `${shift.date} ${shift.start_time}–${endDate === shift.date ? end : `${endDate} ${end}`}`;
}
