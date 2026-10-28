import { describe, expect, it } from 'vitest';
import { planRecurringDates } from '../src/shifts/recurrence';

const SATURDAY = 6;
const MONDAY = 1;

describe('planRecurringDates', () => {
  it('lists every matching weekday, with both ends of the range inclusive', () => {
    // 2026-11-07 and 2026-11-28 are both Saturdays.
    const plan = planRecurringDates({ startDate: '2026-11-07', endDate: '2026-11-28', dayOfWeek: SATURDAY, excludedDates: [] });
    expect(plan.dates).toEqual(['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']);
    expect(plan.holidays).toEqual([]);
  });

  it('starts from the first matching weekday after a mid-week start date', () => {
    // 2026-11-04 is a Wednesday; the first Monday after it is 2026-11-09.
    const plan = planRecurringDates({ startDate: '2026-11-04', endDate: '2026-11-20', dayOfWeek: MONDAY, excludedDates: [] });
    expect(plan.dates).toEqual(['2026-11-09', '2026-11-16']);
  });

  it('moves excluded dates to holidays and ignores exclusions that would never match', () => {
    const plan = planRecurringDates({
      startDate: '2026-12-01',
      endDate: '2026-12-31',
      dayOfWeek: SATURDAY,
      // 2026-12-26 is a Saturday in range; 2026-12-25 is a Friday; 2027-01-02 is out of range.
      excludedDates: ['2026-12-26', '2026-12-25', '2027-01-02', '2026-12-26'],
    });
    expect(plan.dates).toEqual(['2026-12-05', '2026-12-12', '2026-12-19']);
    expect(plan.holidays).toEqual(['2026-12-26']);
  });

  it('returns nothing when the range contains no matching weekday', () => {
    // Tuesday to Thursday has no Saturday.
    const plan = planRecurringDates({ startDate: '2026-11-03', endDate: '2026-11-05', dayOfWeek: SATURDAY, excludedDates: [] });
    expect(plan).toEqual({ dates: [], holidays: [] });
  });

  it('handles leap days and year boundaries', () => {
    // 2028-02-29 is a Tuesday.
    const leap = planRecurringDates({ startDate: '2028-02-20', endDate: '2028-03-10', dayOfWeek: 2, excludedDates: [] });
    expect(leap.dates).toEqual(['2028-02-22', '2028-02-29', '2028-03-07']);

    const newYear = planRecurringDates({ startDate: '2026-12-28', endDate: '2027-01-12', dayOfWeek: MONDAY, excludedDates: [] });
    expect(newYear.dates).toEqual(['2026-12-28', '2027-01-04', '2027-01-11']);
  });

  it('is not affected by daylight-saving changes in any time zone', () => {
    // US clocks change on 2026-03-08 and 2026-11-01; Europe on 2026-03-29 and 2026-10-25.
    const plan = planRecurringDates({ startDate: '2026-03-01', endDate: '2026-04-05', dayOfWeek: 0, excludedDates: [] });
    expect(plan.dates).toEqual(['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22', '2026-03-29', '2026-04-05']);
  });
});
