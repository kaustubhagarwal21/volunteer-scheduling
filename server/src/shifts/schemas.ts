import { z } from 'zod';
import { HttpError } from '../http/errors';
import { Id, IsoDate, TimeOfDay } from '../http/validate';

// Bodies are strict: an unknown key is rejected with a 400 instead of being silently ignored.

const shiftFields = {
  durationMinutes: z.number().int().min(15, 'A shift lasts at least 15 minutes').max(1440, 'A shift lasts at most 24 hours'),
  location: z.string().trim().min(1, 'Location is required').max(200),
  requiredHeadcount: z.number().int().min(1, 'At least one volunteer is required').max(500),
  startTime: TimeOfDay,
};

export const ShiftBody = z.strictObject({ date: IsoDate, ...shiftFields });

export const ShiftPatch = ShiftBody.partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Send at least one field to change',
});

export const GenerateBody = z.strictObject({
  startDate: IsoDate,
  endDate: IsoDate,
  dayOfWeek: z.number().int().min(0).max(6), // 0 = Sunday ... 6 = Saturday
  ...shiftFields,
  excludedDates: z.array(IsoDate).max(366).default([]),
});

export const SignupBody = z.strictObject({
  // Coordinators name the volunteer; volunteers may omit it (they can only sign themselves up).
  volunteerId: Id.optional(),
});

export const NoteBody = z.strictObject({
  note: z.string().trim().min(1, 'Write a note').max(2000),
});

const DERIVED_FIELDS = ['state', 'signupCount', 'spotsLeft', 'closedAt'];

/**
 * The fill state is derived from signups and headcount and can never be set by hand. A request that
 * tries gets an explanation rather than a generic "unrecognised key".
 */
export function rejectDerivedFields(body: unknown): void {
  if (typeof body === 'object' && body !== null && DERIVED_FIELDS.some((field) => field in body)) {
    throw new HttpError(
      400,
      'FILL_STATE_DERIVED',
      "A shift's fill state comes from its signups and required headcount, so it can't be set directly. " +
        'Sign volunteers up or cancel signups to change it, or close the shift once it is over.',
    );
  }
}
