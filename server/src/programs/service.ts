import type { AuthUser } from '../auth/types';
import { QueryParams } from '../db/params';
import { pool, withTransaction } from '../db/pool';
import { badRequest, conflict, notFound } from '../http/errors';
import { SHIFT_COLUMNS, toShiftDto, type ShiftDto, type ShiftRow } from '../shifts/dto';
import { lockShift } from '../shifts/lifecycle';
import { cancelLockedSignup } from '../signups/service';
import { orgClock } from '../time/orgClock';
import { assertCanView, lockActiveProgram, notVisible, visibleProgramsSql } from './access';

export interface ProgramDto {
  id: number;
  name: string;
  description: string;
  archived: boolean;
  archivedAt: string | null;
  memberCount: number;
  upcomingShiftCount: number;
}

interface ProgramRow {
  id: number;
  name: string;
  description: string;
  archived_at: Date | null;
  member_count: number;
  upcoming_shift_count: number;
}

// $1 is the organisation's current time. "Upcoming" means not yet ended, as everywhere else.
const PROGRAM_COLUMNS = `
  p.id, p.name, p.description, p.archived_at,
  (SELECT count(*) FROM program_members pm WHERE pm.program_id = p.id) AS member_count,
  (SELECT count(*) FROM shifts s
    WHERE s.program_id = p.id AND s.deleted_at IS NULL AND s.closed_at IS NULL
      AND upper(s.time_range) > $1::timestamp
  ) AS upcoming_shift_count`;

function toProgramDto(row: ProgramRow): ProgramDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    memberCount: row.member_count,
    upcomingShiftCount: row.upcoming_shift_count,
  };
}

/** Default view hides archived programs; coordinators can ask for the archived ones instead. */
export async function listPrograms(user: AuthUser, archived: boolean): Promise<ProgramDto[]> {
  if (archived && user.role !== 'coordinator') return [];
  const params = new QueryParams();
  params.add(orgClock().now); // $1, used by PROGRAM_COLUMNS
  const { rows } = await pool.query<ProgramRow>(
    `SELECT ${PROGRAM_COLUMNS}
       FROM programs p
      WHERE p.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND ${visibleProgramsSql(user, params)}
      ORDER BY p.name`,
    params.values,
  );
  return rows.map(toProgramDto);
}

export async function getProgram(user: AuthUser, programId: number): Promise<ProgramDto> {
  const { rows } = await pool.query<ProgramRow>(`SELECT ${PROGRAM_COLUMNS} FROM programs p WHERE p.id = $2`, [
    orgClock().now,
    programId,
  ]);
  if (!rows[0]) throw notVisible(user, 'Program');
  await assertCanView(pool, user, { program_id: programId, program_archived: rows[0].archived_at !== null }, 'Program');
  return toProgramDto(rows[0]);
}

export async function createProgram(actor: AuthUser, input: { name: string; description: string }): Promise<ProgramDto> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO programs (name, description, created_by) VALUES ($1, $2, $3) RETURNING id',
    [input.name, input.description, actor.id],
  );
  return getProgram(actor, rows[0].id);
}

export async function updateProgram(
  actor: AuthUser,
  programId: number,
  patch: { name?: string; description?: string },
): Promise<ProgramDto> {
  const { rowCount } = await pool.query(
    `UPDATE programs
        SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
      WHERE id = $1`,
    [programId, patch.name ?? null, patch.description ?? null],
  );
  if (rowCount === 0) throw notFound('Program');
  return getProgram(actor, programId);
}

/**
 * Archiving only flips a timestamp: no shift, signup or history row is touched, so restoring brings
 * everything back as it was. It is refused while volunteers hold signups for shifts that haven't
 * started yet: those people expect to turn up, and once the program is hidden they could neither
 * see nor cancel those signups.
 */
export async function setArchived(actor: AuthUser, programId: number, archive: boolean): Promise<ProgramDto> {
  const clock = orgClock();
  await withTransaction(async (tx) => {
    // FOR UPDATE waits for in-flight signups (they hold FOR SHARE) and blocks new ones meanwhile.
    const { rows } = await tx.query<{ name: string; archived: boolean }>(
      'SELECT name, archived_at IS NOT NULL AS archived FROM programs WHERE id = $1 FOR UPDATE',
      [programId],
    );
    const program = rows[0];
    if (!program) throw notFound('Program');
    if (program.archived === archive) {
      throw conflict(
        archive ? 'ALREADY_ARCHIVED' : 'NOT_ARCHIVED',
        archive ? `${program.name} is already archived.` : `${program.name} is not archived.`,
      );
    }

    if (archive) {
      const upcoming = await tx.query<{ signups: number; shifts: number }>(
        `SELECT count(*) AS signups, count(DISTINCT s.id) AS shifts
           FROM signups su
           JOIN shifts s ON s.id = su.shift_id
          WHERE s.program_id = $1 AND su.cancelled_at IS NULL
            AND s.deleted_at IS NULL AND s.closed_at IS NULL
            AND (s.shift_date + s.start_time) > $2::timestamp`,
        [programId, clock.now],
      );
      const { signups, shifts } = upcoming.rows[0];
      if (signups > 0) {
        throw conflict(
          'ARCHIVE_HAS_UPCOMING_SIGNUPS',
          `${program.name} still has ${signups} upcoming signup${signups === 1 ? '' : 's'} on ${shifts} ` +
            `shift${shifts === 1 ? '' : 's'}. Cancel them or delete those shifts before archiving.`,
        );
      }
    }

    await tx.query(
      `UPDATE programs SET archived_at = ${archive ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1`,
      [programId],
    );
  });
  return getProgram(actor, programId);
}

export interface MemberDto {
  id: number;
  name: string;
  email: string;
  addedAt: string;
  upcomingSignups: number;
}

export async function listMembers(programId: number): Promise<MemberDto[]> {
  const clock = orgClock();
  const { rows } = await pool.query<{ id: number; name: string; email: string; added_at: Date; upcoming_signups: number }>(
    `SELECT u.id, u.name, u.email, pm.added_at,
            (SELECT count(*) FROM signups su JOIN shifts s ON s.id = su.shift_id
              WHERE su.volunteer_id = u.id AND su.cancelled_at IS NULL AND s.program_id = pm.program_id
                AND s.deleted_at IS NULL AND s.closed_at IS NULL
                AND (s.shift_date + s.start_time) > $2::timestamp) AS upcoming_signups
       FROM program_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.program_id = $1
      ORDER BY u.name`,
    [programId, clock.now],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    addedAt: row.added_at.toISOString(),
    upcomingSignups: row.upcoming_signups,
  }));
}

export async function addMember(actor: AuthUser, programId: number, userId: number): Promise<void> {
  await withTransaction(async (tx) => {
    await lockActiveProgram(tx, programId);
    const { rows } = await tx.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw notFound('Volunteer');
    if (rows[0].role !== 'volunteer') {
      throw badRequest('Only volunteers can be added to a program; coordinators already see every program.');
    }
    // An existing membership trips the primary key; the error handler reports 409 ALREADY_MEMBER.
    await tx.query('INSERT INTO program_members (program_id, user_id, added_by) VALUES ($1, $2, $3)', [
      programId,
      userId,
      actor.id,
    ]);
  });
}

/**
 * Removes a volunteer from a program. Their signups for this program's shifts that haven't started
 * yet are cancelled (and recorded on each shift's timeline): someone who no longer belongs to the
 * program shouldn't hold its future spots. Past signups stay — they happened.
 */
export async function removeMember(actor: AuthUser, programId: number, userId: number): Promise<{ cancelledSignups: number }> {
  const clock = orgClock();
  return withTransaction(async (tx) => {
    await lockActiveProgram(tx, programId);
    const removed = await tx.query('DELETE FROM program_members WHERE program_id = $1 AND user_id = $2', [
      programId,
      userId,
    ]);
    if (removed.rowCount === 0) throw notFound('Membership');

    const { rows: upcoming } = await tx.query<{ id: number; shift_id: number }>(
      `SELECT su.id, su.shift_id
         FROM signups su
         JOIN shifts s ON s.id = su.shift_id
        WHERE s.program_id = $1 AND su.volunteer_id = $2 AND su.cancelled_at IS NULL
          AND s.deleted_at IS NULL AND s.closed_at IS NULL
          AND (s.shift_date + s.start_time) > $3::timestamp
        ORDER BY su.shift_id`, // lock shifts in a consistent order to avoid deadlocks
      [programId, userId, clock.now],
    );
    let cancelled = 0;
    for (const signup of upcoming) {
      const shift = await lockShift(tx, signup.shift_id);
      // Re-check under the lock: the volunteer may have cancelled it themselves a moment ago.
      const stillActive = await tx.query('SELECT 1 FROM signups WHERE id = $1 AND cancelled_at IS NULL FOR UPDATE', [
        signup.id,
      ]);
      if (!stillActive.rowCount) continue;
      await cancelLockedSignup(tx, shift, { id: signup.id, volunteerId: userId }, actor.id, 'removed_from_program');
      cancelled += 1;
    }
    return { cancelledSignups: cancelled };
  });
}

export interface MyProgram extends ProgramDto {
  shifts: (ShiftDto & { mySignupId: number | null })[];
}

/**
 * Goal 5: one list of every program the volunteer belongs to, with the shifts in each. Upcoming
 * shifts (not yet ended) by default; past ones on request, so the list doesn't grow without bound.
 */
export async function listMyPrograms(user: AuthUser, includePast: boolean): Promise<MyProgram[]> {
  const clock = orgClock();
  const programs = await listPrograms(user, false);
  if (user.role !== 'volunteer' || programs.length === 0) return programs.map((p) => ({ ...p, shifts: [] }));

  const { rows } = await pool.query<ShiftRow & { my_signup_id: number | null }>(
    `SELECT ${SHIFT_COLUMNS}, mine.id AS my_signup_id
       FROM shifts s
       JOIN programs p ON p.id = s.program_id
       LEFT JOIN signups mine ON mine.shift_id = s.id AND mine.volunteer_id = $2 AND mine.cancelled_at IS NULL
      WHERE s.program_id = ANY($1::int[]) AND s.deleted_at IS NULL
        AND ($3 OR upper(s.time_range) > $4::timestamp)
      ORDER BY s.shift_date, s.start_time`,
    [programs.map((p) => p.id), user.id, includePast, clock.now],
  );
  return programs.map((program) => ({
    ...program,
    shifts: rows
      .filter((row) => row.program_id === program.id)
      .map((row) => ({ ...toShiftDto(row, clock), mySignupId: row.my_signup_id })),
  }));
}

/** Goal 7: every volunteer with signups in, or membership of, the program and their total hours. */
export async function rosterRows(programId: number) {
  const { rows } = await pool.query<{
    name: string;
    email: string;
    is_member: boolean;
    signups: number;
    total_minutes: number;
    closed_minutes: number;
  }>(
    `WITH program_shifts AS (
       SELECT id, duration_minutes, closed_at FROM shifts WHERE program_id = $1 AND deleted_at IS NULL
     ),
     people AS (
       SELECT user_id FROM program_members WHERE program_id = $1
       UNION
       SELECT su.volunteer_id FROM signups su JOIN program_shifts ps ON ps.id = su.shift_id
        WHERE su.cancelled_at IS NULL
     )
     SELECT u.name, u.email,
            EXISTS (SELECT 1 FROM program_members pm WHERE pm.program_id = $1 AND pm.user_id = u.id) AS is_member,
            count(ps.id) AS signups,
            COALESCE(sum(ps.duration_minutes), 0) AS total_minutes,
            COALESCE(sum(ps.duration_minutes) FILTER (WHERE ps.closed_at IS NOT NULL), 0) AS closed_minutes
       FROM people
       JOIN users u ON u.id = people.user_id
       LEFT JOIN (signups su JOIN program_shifts ps ON ps.id = su.shift_id)
              ON su.volunteer_id = u.id AND su.cancelled_at IS NULL
      GROUP BY u.id
      ORDER BY total_minutes DESC, u.name`,
    [programId],
  );
  return rows;
}
