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

/** Route parameter ids such as /shifts/:id. */
export const IdParam = z.object({ id: z.coerce.number().int().positive() });

/** 'YYYY-MM-DD' that is also a real calendar date (rejects 2026-02-30). */
export const IsoDate = z.iso.date();

/** 'HH:MM' 24-hour time. */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time as HH:MM (24-hour)');
