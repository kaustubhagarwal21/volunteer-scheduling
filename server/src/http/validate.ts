import { z } from 'zod';
import { badRequest } from './errors';

/**
 * Validates untrusted input (body, query or params) against a schema.
 * Returns the parsed, typed value or throws a 400 listing every invalid field.
 */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    const summary = fields.map((f) => (f.field === '(root)' ? f.message : `${f.field}: ${f.message}`)).join('; ');
    throw badRequest(`Invalid input — ${summary}`, fields);
  }
  return result.data;
}

/** A database id: a positive whole number that fits Postgres INTEGER. */
export const Id = z.coerce.number().int().positive().max(2_147_483_647);

/** Route parameter ids such as /shifts/:id. */
export const IdParam = z.object({ id: Id });

/**
 * 'YYYY-MM-DD' that is a real calendar date (rejects 2026-02-30 and 'infinity') within the range
 * the shifts table accepts, so a typo like 3026 is a 400 with a reason rather than a database error.
 */
export const IsoDate = z.iso
  .date()
  .refine((date) => date >= '2000-01-01' && date <= '2999-12-31', 'Dates must be between 2000-01-01 and 2999-12-31');

/** Free-text search: trimmed, bounded, and free of control characters (Postgres text can't hold NUL). */
export const SearchText = z
  .string()
  .trim()
  .max(100)
  .regex(/^[^\p{Cc}]*$/u, 'Search text cannot contain control characters');

/** 'HH:MM' 24-hour time, whole minutes only. */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time as HH:MM (24-hour)');
