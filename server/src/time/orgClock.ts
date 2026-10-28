import { config } from '../config';

/**
 * "What time is it for the organisation?" — answered once per request, in one place.
 *
 * Shift dates and start times are wall-clock values in ORG_TIMEZONE. Every rule that depends on the
 * current time (has the shift started, can it be closed yet, is it within three days, what is
 * "this week") receives these values as SQL parameters instead of relying on the database server's
 * own clock or session time zone, which connection poolers do not preserve.
 */
export interface OrgClock {
  /** Organisation-local date, 'YYYY-MM-DD'. */
  today: string;
  /** Organisation-local wall-clock time, 'YYYY-MM-DD HH:MM:SS'; compares with shift_date + start_time. */
  now: string;
  /** Monday of the current week (weeks run Monday to Sunday), 'YYYY-MM-DD'. */
  weekStart: string;
  /** IANA zone, for turning organisation-local times into instants in SQL (AT TIME ZONE). */
  timeZone: string;
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.ORG_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function orgClock(instant: Date = new Date()): OrgClock {
  const part = Object.fromEntries(partsFormatter.formatToParts(instant).map((p) => [p.type, p.value]));
  const today = `${part.year}-${part.month}-${part.day}`;
  return {
    today,
    now: `${today} ${part.hour}:${part.minute}:${part.second}`,
    weekStart: mondayOf(today),
    timeZone: config.ORG_TIMEZONE,
  };
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings (UTC internally, so no DST surprises). */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOf(isoDate: string): string {
  const dayOfWeek = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((dayOfWeek + 6) % 7));
}
