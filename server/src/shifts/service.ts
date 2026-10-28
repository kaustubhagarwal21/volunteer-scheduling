import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/types';
import { pool, withTransaction, type Queryable } from '../db/pool';
import { badRequest, conflict, notFound } from '../http/errors';
import { assertCanView, lockActiveProgram } from '../programs/access';
import { orgClock, type OrgClock } from '../time/orgClock';
import { recordEvent } from '../timeline/events';
import { SHIFT_COLUMNS, hasEnded, toShiftDto, type ShiftDto, type ShiftRow, type ShiftState } from './dto';
import { assertProgramActive, describeWindow, lockShift, lockVolunteerSchedules, onStateChanged } from './lifecycle';

export interface ShiftInput {
  date: string;
  startTime: string;
  durationMinutes: number;
  location: string;
  requiredHeadcount: number;
}

/** A new or moved shift must start in the future: we schedule upcoming work, not past events. */
function assertStartsInFuture(date: string, startTime: string, clock: OrgClock): void {
  if (`${date} ${startTime}:00` <= clock.now) {
    throw badRequest('A shift must start in the future.');
  }
}

export async function loadShift(db: Queryable, shiftId: number, clock: OrgClock): Promise<ShiftDto> {
  const { rows } = await db.query<ShiftRow>(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [shiftId],
  );
  if (!rows[0]) throw notFound('Shift');
  return toShiftDto(rows[0], clock);
}

export async function createShift(actor: AuthUser, programId: number, input: ShiftInput): Promise<ShiftDto> {
  const clock = orgClock();
  assertStartsInFuture(input.date, input.startTime, clock);

  return withTransaction(async (tx) => {
    await lockActiveProgram(tx, programId);
    // A clash on (program, date, start time) is turned into 409 SLOT_TAKEN by the error handler.
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO shifts (program_id, shift_date, start_time, duration_minutes, location, required_headcount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [programId, input.date, input.startTime, input.durationMinutes, input.location, input.requiredHeadcount, actor.id],
    );
    const shiftId = rows[0].id;
    await recordEvent(tx, { shiftId, type: 'created', actorId: actor.id, details: { ...input } });
    return loadShift(tx, shiftId, clock);
  });
}

export async function updateShift(actor: AuthUser, shiftId: number, patch: Partial<ShiftInput>): Promise<ShiftDto> {
  const clock = orgClock();
  return withTransaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    assertProgramActive(shift);
    if (shift.state === 'closed') {
      throw conflict('SHIFT_CLOSED', "Closed shifts are part of the record and can't be edited.");
    }

    const current: ShiftInput = {
      date: shift.date,
      startTime: shift.start_time,
      durationMinutes: shift.duration_minutes,
      location: shift.location,
      requiredHeadcount: shift.required_headcount,
    };
    const next: ShiftInput = { ...current, ...patch };
    const changes = Object.fromEntries(
      (Object.keys(current) as (keyof ShiftInput)[])
        .filter((field) => current[field] !== next[field])
        .map((field) => [field, { from: current[field], to: next[field] }]),
    );
    if (Object.keys(changes).length === 0) return loadShift(tx, shiftId, clock);

    if (next.requiredHeadcount < shift.signup_count) {
      throw conflict(
        'HEADCOUNT_BELOW_SIGNUPS',
        `This shift already has ${shift.signup_count} signups, so its required headcount can't go below ` +
          `${shift.signup_count}. Cancel signups first.`,
      );
    }
    const timeChanged = 'date' in changes || 'startTime' in changes || 'durationMinutes' in changes;
    if (timeChanged) assertStartsInFuture(next.date, next.startTime, clock);

    const { rows } = await tx.query<{ state: ShiftState; time_range: string }>(
      `UPDATE shifts
          SET shift_date = $2, start_time = $3, duration_minutes = $4, location = $5, required_headcount = $6,
              updated_at = now(),
              -- A rescheduled shift is effectively a new slot: any dismissed alert no longer applies.
              alert_dismissed_at = CASE WHEN $7 THEN NULL ELSE alert_dismissed_at END,
              alert_dismissed_by = CASE WHEN $7 THEN NULL ELSE alert_dismissed_by END
        WHERE id = $1
        RETURNING state, time_range::text`,
      [shiftId, next.date, next.startTime, next.durationMinutes, next.location, next.requiredHeadcount, timeChanged],
    );

    if (timeChanged) await moveSignupsToNewTime(tx, shiftId, rows[0].time_range);

    await recordEvent(tx, { shiftId, type: 'updated', actorId: actor.id, details: { changes } });
    await onStateChanged(tx, shift, rows[0].state, actor.id);
    return loadShift(tx, shiftId, clock);
  });
}

/**
 * Signups carry a copy of their shift's time range (for the overlap constraint). When a shift is
 * rescheduled, refuse if that would double-book any of its volunteers, otherwise update the copies.
 */
async function moveSignupsToNewTime(tx: PoolClient, shiftId: number, newRange: string): Promise<void> {
  const volunteers = await tx.query<{ volunteer_id: number }>(
    'SELECT volunteer_id FROM signups WHERE shift_id = $1 AND cancelled_at IS NULL',
    [shiftId],
  );
  await lockVolunteerSchedules(tx, volunteers.rows.map((row) => row.volunteer_id));

  const { rows } = await tx.query<{ volunteer_name: string; program_name: string; date: string; start_time: string; ends_at: string }>(
    `SELECT u.name AS volunteer_name, p.name AS program_name, s.shift_date AS date,
            to_char(s.start_time, 'HH24:MI') AS start_time,
            to_char(upper(s.time_range), 'YYYY-MM-DD HH24:MI:SS') AS ends_at
       FROM signups mine
       JOIN signups other ON other.volunteer_id = mine.volunteer_id
                         AND other.shift_id <> mine.shift_id
                         AND other.cancelled_at IS NULL
                         AND other.time_range && $2::tsrange
       JOIN users u ON u.id = mine.volunteer_id
       JOIN shifts s ON s.id = other.shift_id
       JOIN programs p ON p.id = s.program_id
      WHERE mine.shift_id = $1 AND mine.cancelled_at IS NULL
      LIMIT 1`,
    [shiftId, newRange],
  );
  const clash = rows[0];
  if (clash) {
    throw conflict(
      'SIGNUP_OVERLAP',
      `Moving this shift would double-book ${clash.volunteer_name}, who is signed up for ` +
        `${clash.program_name} (${describeWindow(clash)}).`,
    );
  }
  await tx.query('UPDATE signups SET time_range = $2::tsrange WHERE shift_id = $1 AND cancelled_at IS NULL', [
    shiftId,
    newRange,
  ]);
}

/**
 * Soft delete. The row stays (with deleted_at) because the shift's timeline must outlive it —
 * history can't be destroyed, even by coordinators. Active signups are cancelled first so the
 * volunteers are free again, and every step is recorded.
 */
export async function deleteShift(actor: AuthUser, shiftId: number): Promise<{ cancelledSignups: number }> {
  return withTransaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    assertProgramActive(shift);
    if (shift.state === 'closed') {
      throw conflict('SHIFT_CLOSED', "Closed shifts are part of the record and can't be deleted.");
    }

    const cancelled = await tx.query<{ volunteer_id: number }>(
      `UPDATE signups SET cancelled_at = now(), cancelled_by = $2
        WHERE shift_id = $1 AND cancelled_at IS NULL
        RETURNING volunteer_id`,
      [shiftId, actor.id],
    );
    for (const { volunteer_id } of cancelled.rows) {
      await recordEvent(tx, {
        shiftId,
        type: 'signup_cancelled',
        actorId: actor.id,
        volunteerId: volunteer_id,
        details: { reason: 'shift_deleted' },
      });
    }

    const { rows } = await tx.query<{ state: ShiftState }>(
      `UPDATE shifts SET signup_count = 0, deleted_at = now(), deleted_by = $2, updated_at = now()
        WHERE id = $1 RETURNING state`,
      [shiftId, actor.id],
    );
    await onStateChanged(tx, shift, rows[0].state, actor.id);
    await recordEvent(tx, {
      shiftId,
      type: 'deleted',
      actorId: actor.id,
      details: { cancelledSignups: cancelled.rowCount ?? 0 },
    });
    return { cancelledSignups: cancelled.rowCount ?? 0 };
  });
}

/** Open / Partially Filled / Filled -> Closed, only once the shift's scheduled time has passed. */
export async function closeShift(actor: AuthUser, shiftId: number): Promise<ShiftDto> {
  const clock = orgClock();
  return withTransaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    assertProgramActive(shift);
    if (shift.state === 'closed') throw conflict('ALREADY_CLOSED', 'This shift is already closed.');
    if (!hasEnded(shift, clock)) {
      throw conflict(
        'SHIFT_NOT_OVER',
        `This shift runs ${describeWindow(shift)}. It can only be closed after its scheduled time has passed.`,
      );
    }
    const { rows } = await tx.query<{ state: ShiftState }>(
      'UPDATE shifts SET closed_at = now(), closed_by = $2, updated_at = now() WHERE id = $1 RETURNING state',
      [shiftId, actor.id],
    );
    await onStateChanged(tx, shift, rows[0].state, actor.id);
    return loadShift(tx, shiftId, clock);
  });
}

/** Coordinators' notes are timeline entries, so they can be added but never edited or removed. */
export async function addNote(actor: AuthUser, shiftId: number, note: string): Promise<void> {
  await withTransaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    assertProgramActive(shift);
    await recordEvent(tx, { shiftId, type: 'note', actorId: actor.id, note });
  });
}

export interface SignupSummary {
  id: number;
  volunteer: { id: number; name: string; email?: string };
  createdBy: { id: number; name: string };
  createdAt: string;
}

export async function getShiftDetail(actor: AuthUser, shiftId: number) {
  const clock = orgClock();
  const shift = await loadShift(pool, shiftId, clock);
  await assertCanView(pool, actor, { program_id: shift.programId, program_archived: shift.programArchived }, 'Shift');

  const { rows } = await pool.query<{
    id: number;
    volunteer_id: number;
    volunteer_name: string;
    volunteer_email: string;
    created_by: number;
    created_by_name: string;
    created_at: Date;
  }>(
    `SELECT su.id, su.volunteer_id, v.name AS volunteer_name, v.email AS volunteer_email,
            su.created_by, c.name AS created_by_name, su.created_at
       FROM signups su
       JOIN users v ON v.id = su.volunteer_id
       JOIN users c ON c.id = su.created_by
      WHERE su.shift_id = $1 AND su.cancelled_at IS NULL
      ORDER BY su.created_at`,
    [shiftId],
  );

  const signups: SignupSummary[] = rows.map((row) => ({
    id: row.id,
    // Volunteers see who else is on the shift, but only coordinators see contact details.
    volunteer: {
      id: row.volunteer_id,
      name: row.volunteer_name,
      ...(actor.role === 'coordinator' ? { email: row.volunteer_email } : {}),
    },
    createdBy: { id: row.created_by, name: row.created_by_name },
    createdAt: row.created_at.toISOString(),
  }));

  return {
    shift,
    signups,
    mySignupId: signups.find((signup) => signup.volunteer.id === actor.id)?.id ?? null,
  };
}

export interface TimelineEntry {
  id: number;
  type: string;
  actor: { id: number; name: string; role: string };
  volunteer: { id: number; name: string } | null;
  fromState: ShiftState | null;
  toState: ShiftState | null;
  note: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export async function getTimeline(actor: AuthUser, shiftId: number): Promise<TimelineEntry[]> {
  const shift = await loadShift(pool, shiftId, orgClock());
  await assertCanView(pool, actor, { program_id: shift.programId, program_archived: shift.programArchived }, 'Shift');

  const { rows } = await pool.query(
    `SELECT e.id, e.event_type, e.from_state, e.to_state, e.note, e.details, e.created_at,
            a.id AS actor_id, a.name AS actor_name, a.role AS actor_role,
            v.id AS volunteer_id, v.name AS volunteer_name
       FROM shift_events e
       JOIN users a ON a.id = e.actor_id
       LEFT JOIN users v ON v.id = e.volunteer_id
      WHERE e.shift_id = $1
      ORDER BY e.id`,
    [shiftId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.event_type,
    actor: { id: row.actor_id, name: row.actor_name, role: row.actor_role },
    volunteer: row.volunteer_id ? { id: row.volunteer_id, name: row.volunteer_name } : null,
    fromState: row.from_state,
    toState: row.to_state,
    note: row.note,
    details: row.details,
    createdAt: row.created_at.toISOString(),
  }));
}
