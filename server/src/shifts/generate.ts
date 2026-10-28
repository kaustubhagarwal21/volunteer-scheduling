import type { AuthUser } from '../auth/types';
import { withTransaction } from '../db/pool';
import { badRequest } from '../http/errors';
import { lockActiveProgram } from '../programs/access';
import { addDays, orgClock } from '../time/orgClock';
import { recordEvent } from '../timeline/events';
import { SHIFT_COLUMNS, toShiftDto, type ShiftDto, type ShiftRow } from './dto';
import { planRecurringDates } from './recurrence';
import type { ShiftInput } from './service';

export interface GenerateInput extends Omit<ShiftInput, 'date'> {
  startDate: string;
  endDate: string;
  dayOfWeek: number;
  excludedDates: string[];
}

export interface SkippedDate {
  date: string;
  reason: 'holiday' | 'already_exists';
}

export interface GenerateResult {
  created: ShiftDto[];
  skipped: SkippedDate[];
  /** Excluded dates outside the range or not on the pattern's weekday, so they had no effect. */
  unusedExclusions: string[];
}

const MAX_RANGE_DAYS = 366;

/**
 * Goal 7: bulk-create a program's shifts from a weekly pattern. Reports which shifts were created
 * and which dates were skipped, and why: excluded as a holiday, or the program already had a shift
 * at that date and start time.
 */
export async function generateShifts(actor: AuthUser, programId: number, input: GenerateInput): Promise<GenerateResult> {
  const clock = orgClock();
  if (input.endDate < input.startDate) throw badRequest('The end date must be on or after the start date.');
  if (input.endDate > addDays(input.startDate, MAX_RANGE_DAYS)) {
    throw badRequest(`A pattern can cover at most ${MAX_RANGE_DAYS} days at a time.`);
  }

  const plan = planRecurringDates(input);
  const firstDate = plan.dates[0];
  if (firstDate && `${firstDate} ${input.startTime}:00` <= clock.now) {
    throw badRequest('The first shift in this pattern would start in the past. Choose a later start date.');
  }

  return withTransaction(async (tx) => {
    await lockActiveProgram(tx, programId);

    // One statement for every date. The unique (program, date, start time) index decides which
    // dates already had a shift: those rows are skipped by ON CONFLICT and not RETURNed.
    const inserted = await tx.query<{ id: number; shift_date: string }>(
      `INSERT INTO shifts (program_id, shift_date, start_time, duration_minutes, location, required_headcount, created_by)
       SELECT $1, d, $3, $4, $5, $6, $7 FROM unnest($2::date[]) AS d
       ON CONFLICT (program_id, shift_date, start_time) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id, shift_date`,
      [programId, plan.dates, input.startTime, input.durationMinutes, input.location, input.requiredHeadcount, actor.id],
    );

    const { startTime, durationMinutes, location, requiredHeadcount } = input;
    for (const row of inserted.rows) {
      await recordEvent(tx, {
        shiftId: row.id,
        type: 'created',
        actorId: actor.id,
        details: { source: 'recurring', date: row.shift_date, startTime, durationMinutes, location, requiredHeadcount },
      });
    }

    const createdDates = new Set(inserted.rows.map((row) => row.shift_date));
    const skipped: SkippedDate[] = [
      ...plan.holidays.map((date) => ({ date, reason: 'holiday' as const })),
      ...plan.dates.filter((date) => !createdDates.has(date)).map((date) => ({ date, reason: 'already_exists' as const })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    const usedExclusions = new Set(plan.holidays);
    const unusedExclusions = [...new Set(input.excludedDates)].filter((date) => !usedExclusions.has(date)).sort();

    const { rows } = await tx.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM shifts s JOIN programs p ON p.id = s.program_id
        WHERE s.id = ANY($1::int[]) ORDER BY s.shift_date`,
      [inserted.rows.map((row) => row.id)],
    );
    return { created: rows.map((row) => toShiftDto(row, clock)), skipped, unusedExclusions };
  });
}
