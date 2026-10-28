import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db/pool';
import { HttpError } from '../http/errors';
import { parse } from '../http/validate';
import { orgClock } from '../time/orgClock';
import { currentUser, requireAuth } from './middleware';
import { hashPassword, verifyPasswordOrDummy } from './passwords';
import { clearSessionCookie, createSession, deleteSession, SESSION_COOKIE, setSessionCookie } from './sessions';
import type { AuthUser } from './types';

const Email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));

const RegisterBody = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100)
    .regex(/^[^\p{Cc}]+$/u, 'Name cannot contain control characters'),
  email: Email,
  // bcrypt only uses the first 72 bytes of a password, so refuse longer ones rather than silently
  // ignoring the rest (multi-byte characters count as more than one).
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes'),
});

const LoginBody = z.strictObject({
  email: Email,
  password: z.string().min(1, 'Password is required'),
});

function limiter(options: { windowMs: number; limit: number; skipSuccessfulRequests?: boolean }) {
  return rateLimit({
    ...options,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.NODE_ENV === 'test',
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please wait a few minutes and try again.' },
      });
    },
  });
}

// Only failed sign-ins count, so someone switching between demo accounts is never locked out,
// while password guessing from one address is slowed to 10 tries per 15 minutes.
const loginLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true });
// Each registration costs a bcrypt hash; cap bulk account creation from one address.
const registerLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 20 });

export const authRouter = Router();

authRouter.post('/register', registerLimiter, async (req, res) => {
  const input = parse(RegisterBody, req.body);
  const passwordHash = await hashPassword(input.password);
  // Self-registration always creates a volunteer. There is deliberately no way to pick a role here;
  // coordinator accounts are created by an administrator (see the seed script).
  const { rows } = await pool.query<AuthUser>(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, $2, $3, 'volunteer')
     RETURNING id, email, name, role`,
    [input.email, input.name, passwordHash],
  );
  const user = rows[0];
  setSessionCookie(res, await createSession(pool, user.id));
  res.status(201).json({ user });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const input = parse(LoginBody, req.body);
  const { rows } = await pool.query<AuthUser & { password_hash: string }>(
    'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
    [input.email],
  );
  const row = rows[0];
  const passwordOk = await verifyPasswordOrDummy(input.password, row?.password_hash);
  if (!row || !passwordOk) {
    // Same message whether the email or the password was wrong.
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  setSessionCookie(res, await createSession(pool, row.id));
  res.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role } satisfies AuthUser });
});

authRouter.post('/logout', async (req, res) => {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string') await deleteSession(pool, token);
  clearSessionCookie(res);
  res.status(204).end();
});

// Besides the user, tells the browser the organisation's time zone and today's date there, so the
// client never works out "today" from its own clock (which may be in another zone).
authRouter.get('/me', requireAuth, (req, res) => {
  const clock = orgClock();
  res.json({ user: currentUser(req), orgTimezone: clock.timeZone, today: clock.today });
});
