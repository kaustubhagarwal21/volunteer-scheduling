import { z } from 'zod';
import type { AuthUser } from '../auth/types';
import { containsPattern, QueryParams } from '../db/params';
import { pool } from '../db/pool';
import { IsoDate } from '../http/validate';
import { visibleProgramsSql } from '../programs/access';
import { orgClock } from '../time/orgClock';
import { SHIFT_COLUMNS, toShiftDto, type ShiftDto, type ShiftRow } from './dto';

export const FinderQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    programId: z.coerce.number().int().positive().optional(),
    state: z.enum(['open', 'partially_filled', 'filled', 'closed']).optional(),
    dateFrom: IsoDate.optional(),
    dateTo: IsoDate.optional(),
    sort: z.enum(['date', 'start_time', 'state']).default('date'),
    order: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateFrom'],
  });

export type FinderQuery = z.infer<typeof FinderQuery>;

// ORDER BY can't be a bind parameter, so the column list comes from this fixed map and the
// direction from a two-value enum: user input never reaches the SQL text. Every sort ends in
// s.id so pages are stable when many shifts tie.
const ORDER_BY: Record<FinderQuery['sort'], (dir: 'ASC' | 'DESC') => string> = {
  date: (dir) => `s.shift_date ${dir}, s.start_time ${dir}, s.id ${dir}`,
  start_time: (dir) => `s.start_time ${dir}, s.shift_date ${dir}, s.id ${dir}`,
  // Enum order is the lifecycle order: Open, Partially Filled, Filled, Closed.
  state: (dir) => `s.state ${dir}, s.shift_date ASC, s.start_time ASC, s.id ASC`,
};

export interface FinderResult {
  items: (ShiftDto & { mySignupId: number | null })[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Goal 6: search, filter, sort and paginate shifts across every program the viewer can see —
 * entirely in SQL, so the browser only ever receives one page.
 */
export async function findShifts(user: AuthUser, query: FinderQuery): Promise<FinderResult> {
  const clock = orgClock();
  const params = new QueryParams();
  const where = ['s.deleted_at IS NULL', visibleProgramsSql(user, params)];

  // Archived programs are hidden from the cross-program list. A coordinator who opens an archived
  // program (i.e. filters by its id) still sees its shifts, read-only.
  if (!(user.role === 'coordinator' && query.programId)) where.push('p.archived_at IS NULL');

  if (query.q) {
    const pattern = params.add(containsPattern(query.q));
    where.push(`(p.name ILIKE ${pattern} OR s.location ILIKE ${pattern})`);
  }
  if (query.programId) where.push(`s.program_id = ${params.add(query.programId)}`);
  if (query.state) where.push(`s.state = ${params.add(query.state)}`);
  if (query.dateFrom) where.push(`s.shift_date >= ${params.add(query.dateFrom)}::date`);
  if (query.dateTo) where.push(`s.shift_date <= ${params.add(query.dateTo)}::date`);

  const from = 'FROM shifts s JOIN programs p ON p.id = s.program_id';
  const whereSql = where.join(' AND ');

  const countResult = await pool.query<{ total: number }>(`SELECT count(*) AS total ${from} WHERE ${whereSql}`, [
    ...params.values,
  ]);
  const total = countResult.rows[0].total;

  const viewer = params.add(user.id);
  const limit = params.add(query.pageSize);
  const offset = params.add((query.page - 1) * query.pageSize);
  const { rows } = await pool.query<ShiftRow & { my_signup_id: number | null }>(
    `SELECT ${SHIFT_COLUMNS}, mine.id AS my_signup_id
       ${from}
       LEFT JOIN signups mine ON mine.shift_id = s.id AND mine.volunteer_id = ${viewer} AND mine.cancelled_at IS NULL
      WHERE ${whereSql}
      ORDER BY ${ORDER_BY[query.sort](query.order === 'desc' ? 'DESC' : 'ASC')}
      LIMIT ${limit} OFFSET ${offset}`,
    params.values,
  );

  return {
    items: rows.map((row) => ({ ...toShiftDto(row, clock), mySignupId: row.my_signup_id })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}
