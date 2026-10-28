import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/types';
import { QueryParams } from '../db/params';
import { pool, withTransaction } from '../db/pool';
import { conflict } from '../http/errors';
import { visibleProgramsSql } from '../programs/access';
import { hasStarted, SHIFT_COLUMNS, toShiftDto, type ShiftDto, type ShiftRow } from '../shifts/dto';
import { lockProgramOfShift, lockShift, type LockedShift } from '../shifts/lifecycle';
import { addDays, orgClock, type OrgClock } from '../time/orgClock';
import { recordEvent } from '../timeline/events';

/** How far ahead an understaffed shift raises an alert, in days (today plus the next three). */
export const ALERT_WINDOW_DAYS = 3;

/**
 * Goal 10's definition of "understaffed", as SQL over shifts `s` joined to programs `p`:
 * still Open or Partially Filled, not started yet, and dated today or within the next three days.
 * It is evaluated at query time, so a shift enters and leaves the alert list on its own as signups,
 * cancellations and the clock move. (Once a shift starts, nobody can sign up through the app any
 * more, so the alert could no longer be acted on.)
 */
function understaffedSql(params: QueryParams, clock: OrgClock): string {
  const today = params.add(clock.today);
  return `s.deleted_at IS NULL
      AND p.archived_at IS NULL
      AND s.state IN ('open', 'partially_filled')
      AND s.shift_date BETWEEN ${today}::date AND ${today}::date + ${ALERT_WINDOW_DAYS}
      AND (s.shift_date + s.start_time) > ${params.add(clock.now)}::timestamp`;
}

/** Includes the viewer's own signup, so the alerts page can offer Sign up or Cancel. */
type AlertShift = ShiftDto & { mySignupId: number | null };

export interface AlertsResponse {
  /** Active (not dismissed) alerts the viewer can see: the number on the navigation badge. */
  count: number;
  alerts: AlertShift[];
  /** Still understaffed but dismissed by a coordinator. Coordinators only. */
  dismissed: AlertShift[];
}

/**
 * Everyone sees the understaffed shifts in the programs they can see (volunteers are the people who
 * can fix them); only coordinators can dismiss. A dismissal is per shift, so it hides the alert for
 * everyone until a cancellation drops the shift out of Filled again.
 */
export async function listAlerts(user: AuthUser): Promise<AlertsResponse> {
  const clock = orgClock();
  const params = new QueryParams();
  const viewer = params.add(user.id);
  const { rows } = await pool.query<ShiftRow & { dismissed: boolean; my_signup_id: number | null }>(
    `SELECT ${SHIFT_COLUMNS}, s.alert_dismissed_at IS NOT NULL AS dismissed, mine.id AS my_signup_id
       FROM shifts s
       JOIN programs p ON p.id = s.program_id
       LEFT JOIN signups mine ON mine.shift_id = s.id AND mine.volunteer_id = ${viewer} AND mine.cancelled_at IS NULL
      WHERE ${understaffedSql(params, clock)} AND ${visibleProgramsSql(user, params)}
      ORDER BY s.shift_date, s.start_time, s.id`,
    params.values,
  );
  const toAlert = (row: (typeof rows)[number]): AlertShift => ({ ...toShiftDto(row, clock), mySignupId: row.my_signup_id });
  const alerts = rows.filter((row) => !row.dismissed).map(toAlert);
  const dismissed = user.role === 'coordinator' ? rows.filter((row) => row.dismissed).map(toAlert) : [];
  return { count: alerts.length, alerts, dismissed };
}

/**
 * Hides a shift's alert. It comes back automatically if a cancellation later drops the shift out of
 * Filled while it is still within the window (see cancelLockedSignup in signups/service.ts).
 */
export async function dismissAlert(actor: AuthUser, shiftId: number): Promise<void> {
  const clock = orgClock();
  await withTransaction(async (tx) => {
    await lockProgramOfShift(tx, shiftId);
    const shift = await lockShift(tx, shiftId); // 404 for unknown/deleted shifts; serialises with signups
    const params = new QueryParams();
    const id = params.add(shiftId);
    const by = params.add(actor.id);
    const { rowCount } = await tx.query(
      `UPDATE shifts s SET alert_dismissed_at = now(), alert_dismissed_by = ${by}
         FROM programs p
        WHERE p.id = s.program_id AND s.id = ${id} AND s.alert_dismissed_at IS NULL
          AND ${understaffedSql(params, clock)}`,
      params.values,
    );
    if (rowCount === 0) throw conflict('NO_ACTIVE_ALERT', await whyNoAlert(tx, shift, clock));
    await recordEvent(tx, { shiftId, type: 'alert_dismissed', actorId: actor.id });
  });
}

/** The specific reason a shift has no alert to dismiss, checked in the same order as the definition. */
async function whyNoAlert(tx: PoolClient, shift: LockedShift, clock: OrgClock): Promise<string> {
  if (shift.program_archived) return `${shift.program_name} is archived, so its shifts don't raise alerts.`;
  if (shift.state === 'closed') return 'This shift is closed, so it has no alert.';
  if (shift.state === 'filled') return 'This shift is filled, so it has no understaffing alert.';
  if (hasStarted(shift, clock)) return 'This shift has already started, so its alert no longer applies.';
  if (shift.date > addDays(clock.today, ALERT_WINDOW_DAYS)) {
    return `Alerts only cover shifts in the next ${ALERT_WINDOW_DAYS} days; this one is further out.`;
  }
  const { rows } = await tx.query<{ dismissed: boolean }>(
    'SELECT alert_dismissed_at IS NOT NULL AS dismissed FROM shifts WHERE id = $1',
    [shift.id],
  );
  return rows[0].dismissed ? 'This alert has already been dismissed.' : 'This shift has no active alert to dismiss.';
}
