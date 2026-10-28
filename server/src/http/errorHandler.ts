import type { ErrorRequestHandler } from 'express';
import { HttpError } from './errors';

/**
 * Database constraints are the last line of defence. Services check the same rules first so
 * users normally get a specific message; these only fire if two requests race past those checks.
 */
const CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  signups_no_overlap: {
    code: 'SIGNUP_OVERLAP',
    message: 'That volunteer already holds a signup for a shift whose time overlaps this one.',
  },
  signups_one_active_per_shift_uidx: {
    code: 'ALREADY_SIGNED_UP',
    message: 'That volunteer is already signed up for this shift.',
  },
  shifts_signup_count_within_headcount: {
    code: 'HEADCOUNT_EXCEEDED',
    message: "That change would leave the shift with more signups than its required headcount.",
  },
  shifts_program_slot_uidx: {
    code: 'SLOT_TAKEN',
    message: 'This program already has a shift at that date and start time.',
  },
  users_email_key: { code: 'EMAIL_TAKEN', message: 'An account with that email already exists.' },
  program_members_pkey: { code: 'ALREADY_MEMBER', message: 'That volunteer is already a member of this program.' },
};

interface PgError {
  code: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && typeof (err as PgError).code === 'string';
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  // Malformed JSON body (thrown by express.json()).
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
    return;
  }

  if (isPgError(err) && err.constraint && CONSTRAINT_MESSAGES[err.constraint]) {
    res.status(409).json({ error: CONSTRAINT_MESSAGES[err.constraint] });
    return;
  }

  // Deadlock / serialization failure: Postgres rolled our transaction back so another could finish.
  // Nothing was written; the request is safe to retry.
  if (isPgError(err) && (err.code === '40P01' || err.code === '40001')) {
    res.status(409).json({
      error: { code: 'CONCURRENT_CHANGE', message: 'Someone else changed this at the same moment. Please try again.' },
    });
    return;
  }

  // Postgres puts the whole failing row in `detail` (it can include a password hash), so log a
  // trimmed-down version rather than the raw error object.
  const { message, stack } = err instanceof Error ? err : { message: String(err), stack: undefined };
  console.error('Unhandled error:', { message, code: isPgError(err) ? err.code : undefined, stack });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.' } });
};
