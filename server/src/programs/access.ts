import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/types';
import type { QueryParams } from '../db/params';
import type { Queryable } from '../db/pool';
import { conflict, notFound } from '../http/errors';

/**
 * Inside a transaction that adds shifts or changes membership: locks the program row (FOR SHARE)
 * so it can't be archived until we commit, and refuses if it is already archived.
 */
export async function lockActiveProgram(tx: PoolClient, programId: number): Promise<{ id: number; name: string }> {
  const { rows } = await tx.query<{ id: number; name: string; archived: boolean }>(
    'SELECT id, name, archived_at IS NOT NULL AS archived FROM programs WHERE id = $1 FOR SHARE',
    [programId],
  );
  const program = rows[0];
  if (!program) throw notFound('Program');
  if (program.archived) {
    throw conflict('PROGRAM_ARCHIVED', `${program.name} is archived. Restore the program first.`);
  }
  return program;
}

export async function isMember(db: Queryable, programId: number, userId: number): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM program_members WHERE program_id = $1 AND user_id = $2', [
    programId,
    userId,
  ]);
  return rowCount === 1;
}

/**
 * The visibility rule, for a single program (or a shift/signup inside it).
 * Coordinators can see every program. A volunteer can only see active programs they belong to;
 * anything else is reported as "not found" rather than "forbidden", so its existence isn't revealed.
 */
export async function assertCanView(
  db: Queryable,
  user: AuthUser,
  program: { program_id: number; program_archived: boolean },
  what: string,
): Promise<void> {
  if (user.role === 'coordinator') return;
  if (program.program_archived || !(await isMember(db, program.program_id, user.id))) {
    throw notFound(what);
  }
}

/** The same rule as a SQL condition for list queries over programs aliased `p`. */
export function visibleProgramsSql(user: AuthUser, params: QueryParams): string {
  if (user.role === 'coordinator') return 'TRUE';
  return `(p.archived_at IS NULL AND EXISTS (
            SELECT 1 FROM program_members pm WHERE pm.program_id = p.id AND pm.user_id = ${params.add(user.id)}))`;
}
