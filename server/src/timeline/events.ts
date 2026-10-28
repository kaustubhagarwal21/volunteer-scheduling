import type { Queryable } from '../db/pool';
import type { ShiftState } from '../shifts/dto';

export type ShiftEventType =
  | 'created'
  | 'updated'
  | 'state_changed'
  | 'signup_created'
  | 'signup_cancelled'
  | 'note'
  | 'alert_dismissed'
  | 'deleted';

export interface NewShiftEvent {
  shiftId: number;
  type: ShiftEventType;
  /** Who did it (a coordinator, or the volunteer acting for themselves). */
  actorId: number;
  /** Whose signup it was, for signup events. */
  volunteerId?: number;
  fromState?: ShiftState;
  toState?: ShiftState;
  note?: string;
  details?: Record<string, unknown>;
}

/**
 * Appends one entry to a shift's timeline. This is the only code that writes history, and it is
 * always called inside the same transaction as the change it describes, so the timeline can never
 * disagree with the data. Entries are never updated or deleted (the database rejects it).
 */
export async function recordEvent(db: Queryable, event: NewShiftEvent): Promise<void> {
  await db.query(
    `INSERT INTO shift_events (shift_id, event_type, actor_id, volunteer_id, from_state, to_state, note, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.shiftId,
      event.type,
      event.actorId,
      event.volunteerId ?? null,
      event.fromState ?? null,
      event.toState ?? null,
      event.note ?? null,
      event.details ? JSON.stringify(event.details) : null,
    ],
  );
}
