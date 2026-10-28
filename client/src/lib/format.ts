// Shift dates and times arrive as wall-clock strings in the organisation's time zone
// ('2026-11-02', '09:00'). They are formatted as-is, never converted to the viewer's zone.

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** '2026-11-02' -> 'Mon 2 Nov 2026' */
export function formatDate(isoDate: string): string {
  return dateFormatter.format(new Date(`${isoDate}T00:00:00Z`)).replace(',', '');
}

/** '09:00' -> '9:00 am' */
export function formatTime(hhmm: string): string {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const suffix = hours < 12 ? 'am' : 'pm';
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

/** 90 -> '1h 30m', 120 -> '2h', 45 -> '45m' */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** '09:00' + 150 minutes -> '11:30' (wraps past midnight). */
export function addMinutes(hhmm: string, minutes: number): string {
  const [hours, mins] = hhmm.split(':').map(Number);
  const total = (hours * 60 + mins + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** An absolute instant (e.g. when a signup was made), shown in the organisation's time zone. */
export function formatTimestamp(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
