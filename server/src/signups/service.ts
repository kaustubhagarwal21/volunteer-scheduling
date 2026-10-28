import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/types';
import { withTransaction } from '../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { assertCanView, isMember } from '../programs/access';
import { hasStarted } from '../shifts/dto';
import {
  adjustSignupCount,
  assertProgramActive,
  describeWindow,
  lockShift,
  lockVolunteerSchedules,
  type LockedShift,
} from '../shifts/lifecycle';
import { orgClock } from '../time/orgClock';
import { recordEvent } from '../timeline/events';

/**
 * Creates a signup, enforcing every rule from goal 4. Runs in one transaction with the shift row
 * locked, so the checks and the write cannot be interleaved with another request for the same shift.
 * The database re-checks the critical ones (headcount CHECK, overlap EXCLUDE) as a backstop.
 */
export async function signUp(actor: AuthUser, shiftId: number, requestedVolunteerId?: number): Promise<{ id: number }> {
  if (actor.role === 'volunteer' && requestedVolunteerId !== undefined && requestedVolunteerId !== actor.id) {
    throw forbidden('Volunteers can only sign themselves up.');
  }
  const volunteerId = actor.role === 'volunteer' ? actor.id : requestedVolunteerId;
  if (volunteerId === undefined) throw badRequest('Choose which volunteer to sign up (volunteerId).');

  const clock = orgClock();
  return withTransaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    await assertCanView(tx, actor, shift, 'Shift');
    assertProgramActive(shift);

    if (shift.state === 'closed') {
      throw conflict('SHIFT_CLOSED', 'This shift is closed, so it no longer accepts signups.');
    }
    if (shift.state === 'filled') {
      throw conflict(
        'SHIFT_FILLED',
        `This shift is already filled (${shift.signup_count} of ${shift.required_headcount} spots taken).`,
      );
    }
    if (hasStarted(shift, clock)) {
      throw conflict('SHIFT_STARTED', 'This shift has already started, so it can no longer take signups.');
    }

    const volunteer = await loadVolunteer(tx, volunteerId);
    await lockVolunteerSchedules(tx, [volunteer.id]);
    const isSelf = volunteer.id === actor.id;
    if (!(await isMember(tx, shift.program_id, volunteer.id))) {
      throw conflict(
        'NOT_A_MEMBER',
        `${isSelf ? "You aren't" : `${volunteer.name} isn't`} a member of ${shift.program_name}. ` +
          'A coordinator needs to add them to the program first.',
      );
    }

    const existing = await tx.query(
      'SELECT 1 FROM signups WHERE shift_id = $1 AND volunteer_id = $2 AND cancelled_at IS NULL',
      [shift.id, volunteer.id],
    );
    if (existing.rowCount) {
      throw conflict('ALREADY_SIGNED_UP', `${isSelf ? "You're" : `${volunteer.name} is`} already signed up for this shift.`);
    }

    const clash = await findOverlappingSignup(tx, volunteer.id, shift.time_range);
    if (clash) {
      throw conflict(
        'SIGNUP_OVERLAP',
        `This shift overlaps ${isSelf ? 'your' : `${volunteer.name}'s`} signup for ${clash.program_name} ` +
          `(${describeWindow(clash)}). A volunteer can't be in two places at once.`,
      );
    }

    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO signups (shift_id, volunteer_id, time_range, created_by)
       VALUES ($1, $2, $3::tsrange, $4)
       RETURNING id`,
      [shift.id, volunteer.id, shift.time_range, actor.id],
    );
    await recordEvent(tx, { shiftId: shift.id, type: 'signup_created', actorId: actor.id, volunteerId: volunteer.id });
    await adjustSignupCount(tx, shift, 1, actor.id);
    return { id: rows[0].id };
  });
}

/** Cancels a signup: the volunteer for their own, or a coordinator for anyone's. */
export async function cancelSignup(actor: AuthUser, signupId: number): Promise<void> {
  const clock = orgClock();
  await withTransaction(async (tx) => {
    // Lock the shift before the signup, the same order signUp uses, so the two never deadlock.
    const ref = await tx.query<{ shift_id: number }>('SELECT shift_id FROM signups WHERE id = $1', [signupId]);
    if (!ref.rows[0]) throw notFound('Signup');
    const shift = await lockShift(tx, ref.rows[0].shift_id);
    await assertCanView(tx, actor, shift, 'Signup');

    const { rows } = await tx.query<{ volunteer_id: number; cancelled_at: Date | null }>(
      'SELECT volunteer_id, cancelled_at FROM signups WHERE id = $1 FOR UPDATE',
      [signupId],
    );
    const signup = rows[0];
    if (actor.role === 'volunteer' && signup.volunteer_id !== actor.id) {
      throw forbidden('You can only cancel your own signups.');
    }
    if (signup.cancelled_at) throw conflict('ALREADY_CANCELLED', 'This signup has already been cancelled.');
    assertProgramActive(shift);
    if (shift.state === 'closed') {
      throw conflict('SHIFT_CLOSED', 'This shift is closed, so its signups can no longer be changed.');
    }
    // Coordinators may still cancel after the start (e.g. to record a no-show) until the shift is closed.
    if (actor.role === 'volunteer' && hasStarted(shift, clock)) {
      throw conflict(
        'SHIFT_STARTED',
        'This shift has already started, so you can no longer cancel it yourself. Please contact a coordinator.',
      );
    }

    await cancelLockedSignup(tx, shift, { id: signupId, volunteerId: signup.volunteer_id }, actor.id);
  });
}

/**
 * The write half of a cancellation, shared with "remove member" and "delete shift".
 * The caller must hold the shift lock and has already checked the rules.
 */
export async function cancelLockedSignup(
  tx: PoolClient,
  shift: LockedShift,
  signup: { id: number; volunteerId: number },
  actorId: number,
  reason?: 'removed_from_program',
): Promise<void> {
  await tx.query('UPDATE signups SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1', [signup.id, actorId]);
  await recordEvent(tx, {
    shiftId: shift.id,
    type: 'signup_cancelled',
    actorId,
    volunteerId: signup.volunteerId,
    details: reason ? { reason } : undefined,
  });
  await adjustSignupCount(tx, shift, -1, actorId);
}

async function loadVolunteer(tx: PoolClient, userId: number): Promise<{ id: number; name: string }> {
  const { rows } = await tx.query<{ id: number; name: string; role: string }>(
    'SELECT id, name, role FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw notFound('Volunteer');
  if (rows[0].role !== 'volunteer') throw badRequest('Only volunteers can be signed up for shifts.');
  return rows[0];
}

async function findOverlappingSignup(tx: PoolClient, volunteerId: number, timeRange: string) {
  const { rows } = await tx.query<{ program_name: string; date: string; start_time: string; ends_at: string }>(
    `SELECT p.name AS program_name,
            s.shift_date AS date,
            to_char(s.start_time, 'HH24:MI') AS start_time,
            to_char(upper(s.time_range), 'YYYY-MM-DD HH24:MI:SS') AS ends_at
       FROM signups su
       JOIN shifts s ON s.id = su.shift_id
       JOIN programs p ON p.id = s.program_id
      WHERE su.volunteer_id = $1
        AND su.cancelled_at IS NULL
        AND su.time_range && $2::tsrange
      LIMIT 1`,
    [volunteerId, timeRange],
  );
  return rows[0] ?? null;
}
