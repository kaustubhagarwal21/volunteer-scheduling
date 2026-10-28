export interface RecurrencePlan {
  /** Dates in the range on the chosen weekday that should get a shift. */
  dates: string[];
  /** Dates in the range on the chosen weekday that were excluded as holidays. */
  holidays: string[];
}

export interface RecurrenceInput {
  startDate: string; // 'YYYY-MM-DD', inclusive
  endDate: string; // 'YYYY-MM-DD', inclusive
  dayOfWeek: number; // 0 = Sunday ... 6 = Saturday (same as JavaScript getDay and Postgres EXTRACT(DOW))
  excludedDates: string[];
}

const ONE_WEEK_DAYS = 7;

/**
 * Lists every date from startDate to endDate (both inclusive) that falls on dayOfWeek, split into
 * dates to schedule and dates excluded as holidays. Excluded dates that are not on that weekday,
 * or are outside the range, simply never match.
 *
 * Pure function: no database, no clock. Dates are plain 'YYYY-MM-DD' strings and the arithmetic is
 * done in UTC, so neither the server's time zone nor a daylight-saving change can shift a date.
 */
export function planRecurringDates({ startDate, endDate, dayOfWeek, excludedDates }: RecurrenceInput): RecurrencePlan {
  const excluded = new Set(excludedDates);
  const plan: RecurrencePlan = { dates: [], holidays: [] };

  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  // Move forward to the first matching weekday, then step one week at a time.
  cursor.setUTCDate(cursor.getUTCDate() + ((dayOfWeek - cursor.getUTCDay() + ONE_WEEK_DAYS) % ONE_WEEK_DAYS));

  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    (excluded.has(date) ? plan.holidays : plan.dates).push(date);
    cursor.setUTCDate(cursor.getUTCDate() + ONE_WEEK_DAYS);
  }
  return plan;
}
