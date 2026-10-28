import { describe, expect, it } from 'vitest';
import { addDays, orgClock } from '../src/time/orgClock';

// The test environment pins ORG_TIMEZONE to Asia/Kolkata (UTC+05:30, no daylight saving).
describe('orgClock', () => {
  it('reports the organisation-local date and time, not UTC', () => {
    // 20:00 UTC on Wednesday 28 Oct is already 01:30 on Thursday 29 Oct in Kolkata.
    const clock = orgClock(new Date('2026-10-28T20:00:00Z'));
    expect(clock.today).toBe('2026-10-29');
    expect(clock.now).toBe('2026-10-29 01:30:00');
    expect(clock.timeZone).toBe('Asia/Kolkata');
  });

  it('starts the week on Monday', () => {
    expect(orgClock(new Date('2026-10-28T06:00:00Z')).weekStart).toBe('2026-10-26'); // Wednesday
    expect(orgClock(new Date('2026-10-26T06:00:00Z')).weekStart).toBe('2026-10-26'); // Monday itself
    expect(orgClock(new Date('2026-11-01T06:00:00Z')).weekStart).toBe('2026-10-26'); // Sunday belongs to the same week
  });

  it('uses 00 rather than 24 for the midnight hour', () => {
    expect(orgClock(new Date('2026-10-28T18:30:00Z')).now).toBe('2026-10-29 00:00:00');
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
