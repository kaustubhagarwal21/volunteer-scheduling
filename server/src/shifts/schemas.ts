import { z } from 'zod';
import { IsoDate, TimeOfDay } from '../http/validate';

const shiftFields = {
  durationMinutes: z.number().int().min(15, 'A shift lasts at least 15 minutes').max(1440, 'A shift lasts at most 24 hours'),
  location: z.string().trim().min(1, 'Location is required').max(200),
  requiredHeadcount: z.number().int().min(1, 'At least one volunteer is required').max(500),
  startTime: TimeOfDay,
};

export const ShiftBody = z.object({ date: IsoDate, ...shiftFields });

export const ShiftPatch = ShiftBody.partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Send at least one field to change',
});

export const GenerateBody = z.object({
  startDate: IsoDate,
  endDate: IsoDate,
  dayOfWeek: z.number().int().min(0).max(6), // 0 = Sunday ... 6 = Saturday
  ...shiftFields,
  excludedDates: z.array(IsoDate).max(366).default([]),
});

export const SignupBody = z.object({
  // Coordinators name the volunteer; volunteers may omit it (they can only sign themselves up).
  volunteerId: z.number().int().positive().optional(),
});

export const NoteBody = z.object({
  note: z.string().trim().min(1, 'Write a note').max(2000),
});
