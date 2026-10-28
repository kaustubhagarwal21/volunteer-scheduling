import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/types';
import { pool, withTransaction, type Queryable } from '../db/pool';
import { badRequest, conflict, notFound } from '../http/errors';
import { assertCanView, lockActiveProgram, notVisible } from '../programs/access';
import { orgClock, type OrgClock } from '../time/orgClock';
import { recordEvent } from '../timeline/events';
import { SHIFT_COLUMNS, hasEnded, hasStarted, toShiftDto, type ShiftDto, type ShiftRow, type ShiftState } from './dto';
import {
  assertProgramActive,
  describeWindow,
  lockProgramOfShift,
  lockShift,
  lockVolunteerSchedules,
  recordStateChange,
} from './lifecycle';

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

/** Friendly version of the unique (program, date, start time) index, which stays as the backstop. */
async function assertSlotFree(tx: PoolClient, programId: number, date: string, startTime: string, exceptShiftId = 0) {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM shifts
      WHERE program_id = $1 AND shift_date = $2 AND start_time = $3 AND deleted_at IS NULL AND id <> $4`,
    [programId, date, startTime, exceptShiftId],
  );
  if (rowCount) {
    throw conflict('SLOT_TAKEN', `This program already has a shift on ${date} at ${startTime}.`);
  }
}

/**
 * One shift for display, or null. Deleted shifts are returned only with includeDeleted (used for
 * coordinators, so the history of a deleted shift is never lost to them).
 */
async function findShift(
  db: Queryable,
  shiftId: number,
  clock: OrgClock,
  options: { includeDeleted?: boolean } = {},
): Promise<ShiftDto | null> {
  const { rows } = await db.query<ShiftRow>(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND ($2 OR s.deleted_at IS NULL)`,
    [shiftId, options.includeDeleted ?? false],
  );
  return rows[0] ? toShiftDto(rows[0], clock) : null;
}

export async function loadShift(db: Queryable, shiftId: number, clock: OrgClock): Promise<ShiftDto> {
  const shift = await findShift(db, shiftId, clock);
  if (!shift) throw notFound('Shift');
  return shift;
}

export async function createShift(actor: AuthUser, programId: number, input: ShiftInput): Promise<ShiftDto> {
  const clock = orgClock();
  assertStartsInFuture(input.date, input.startTime, clock);

  return withTransaction(async (tx) => {
    await lockActiveProgram(tx, programId);
    await assertSlotFree(tx, programId, input.date, input.startTime);
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
    await lockProgramOfShift(tx, shiftId);
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
    if (timeChanged) {
      if (hasStarted(shift, clock)) {
        throw conflict('SHIFT_STARTED', 'This shift has already started, so its date and time can no longer change.');
      }
      assertStartsInFuture(next.date, next.startTime, clock);
      await assertSlotFree(tx, shift.program_id, next.date, next.startTime, shiftId);
      await assertNoDoubleBooking(tx, shiftId, next);
    }

    // Changing the window regenerates time_range, and the foreign key cascades the new window to
    // the signups' copies (the overlap constraint re-checks them on the way).
    const { rows } = await tx.query<{ state: ShiftState }>(
      `UPDATE shifts
          SET shift_date = $2, start_time = $3, duration_minutes = $4, location = $5, required_headcount = $6,
              updated_at = now()
        WHERE id = $1
        RETURNING state`,
      [shiftId, next.date, next.startTime, next.durationMinutes, next.location, next.requiredHeadcount],
    );

    await recordEvent(tx, { shiftId, type: 'updated', actorId: actor.id, details: { changes } });
    await recordStateChange(tx, shift, rows[0].state, actor.id);
    return loadShift(tx, shiftId, clock);
  });
}

/**
 * Before moving a shift, refuse if any volunteer on it already holds another signup at the new
 * time. The database would refuse too (overlap constraint), but this names who and where.
 */
async function assertNoDoubleBooking(tx: PoolClient, shiftId: number, next: ShiftInput): Promise<void> {
  const volunteers = await tx.query<{ volunteer_id: number }>(
    'SELECT volunteer_id FROM signups WHERE shift_id = $1 AND cancelled_at IS NULL',
    [shiftId],
  );
  await lockVolunteerSchedules(tx, volunteers.rows.map((row) => row.volunteer_id));

  const { rows } = await tx.query<{ volunteer_name: string; program_name: string; date: string; start_time: string; ends_at: string }>(
    `WITH new_window AS (
       SELECT tsrange($2::date + $3::time, $2::date + $3::time + make_interval(mins => $4), '[)') AS r
     )
     SELECT u.name AS volunteer_name, p.name AS program_name, s.shift_date AS date,
            to_char(s.start_time, 'HH24:MI') AS start_time,
            to_char(upper(s.time_range), 'YYYY-MM-DD HH24:MI:SS') AS ends_at
       FROM signups mine
       JOIN signups other ON other.volunteer_id = mine.volunteer_id
                         AND other.shift_id <> mine.shift_id
                         AND other.cancelled_at IS NULL
       JOIN new_window ON other.time_range && new_window.r
       JOIN users u ON u.id = mine.volunteer_id
       JOIN shifts s ON s.id = other.shift_id
       JOIN programs p ON p.id = s.program_id
      WHERE mine.shift_id = $1 AND mine.cancelled_at IS NULL
      LIMIT 1`,
    [shiftId, next.date, next.startTime, next.durationMinutes],
  );
  const clash = rows[0];
  if (clash) {
    throw conflict(
      'SIGNUP_OVERLAP',
      `Moving this shift would double-book ${clash.volunteer_name}, who is signed up for ` +
        `${clash.program_name} (${describeWindow(clash)}).`,
    );
  }
}

/**
 * Soft delete, for shifts that haven't started. The row stays (with deleted_at) because the shift's
 * timeline must outlive it — history can't be destroyed, even by coordinators. Active signups are
 * cancelled first so the volunteers are free again, and every step is recorded. A shift that has
 * started is part of the record: close it instead.
 */
export async function deleteShift(actor: AuthUser, shiftId: number): Promise<{ cancelledSignups: number }> {
  const clock = orgClock();
  return withTransaction(async (tx) => {
    await lockProgramOfShift(tx, shiftId);
    const shift = await lockShift(tx, shiftId);
    assertProgramActive(shift);
    if (shift.state === 'closed') {
      throw conflict('SHIFT_CLOSED', "Closed shifts are part of the record and can't be deleted.");
    }
    if (hasStarted(shift, clock)) {
      throw conflict(
        'SHIFT_STARTED',
        'This shift has already started, so it is part of the record. Close it instead (cancel any no-shows first).',
      );
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
    await recordStateChange(tx, shift, rows[0].state, actor.id);
    const cancelledSignups = cancelled.rowCount ?? 0;
    await recordEvent(tx, { shiftId, type: 'deleted', actorId: actor.id, details: { cancelledSignups } });
    return { cancelledSignups };
  });
}

/** Open / Partially Filled / Filled -> Closed, only once the shift's scheduled time has passed. */
export async function closeShift(actor: AuthUser, shiftId: number): Promise<ShiftDto> {
  const clock = orgClock();
  return withTransaction(async (tx) => {
    await lockProgramOfShift(tx, shiftId);
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
    await recordStateChange(tx, shift, rows[0].state, actor.id);
    return loadShift(tx, shiftId, clock);
  });
}

/** Coordinators' notes are timeline entries, so they can be added but never edited or removed. */
export async function addNote(actor: AuthUser, shiftId: number, note: string): Promise<void> {
  await withTransaction(async (tx) => {
    await lockProgramOfShift(tx, shiftId);
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

async function loadVisibleShift(actor: AuthUser, shiftId: number, clock: OrgClock): Promise<ShiftDto> {
  const shift = await findShift(pool, shiftId, clock, { includeDeleted: actor.role === 'coordinator' });
  if (!shift) throw notVisible(actor, 'Shift');
  await assertCanView(pool, actor, { program_id: shift.programId, program_archived: shift.programArchived }, 'Shift');
  return shift;
}

export async function getShiftDetail(actor: AuthUser, shiftId: number) {
  const clock = orgClock();
  const shift = await loadVisibleShift(actor, shiftId, clock);

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

/** Goal 9: everything that ever happened to a shift, oldest first. Readable by anyone who can see the shift. */
export async function getTimeline(actor: AuthUser, shiftId: number): Promise<TimelineEntry[]> {
  await loadVisibleShift(actor, shiftId, orgClock());

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
