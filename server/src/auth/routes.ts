import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db/pool';
import { HttpError } from '../http/errors';
import { parse } from '../http/validate';
import { currentUser, requireAuth } from './middleware';
import { hashPassword, verifyPasswordOrDummy } from './passwords';
import { clearSessionCookie, createSession, deleteSession, SESSION_COOKIE, setSessionCookie } from './sessions';
import type { AuthUser } from './types';

const Email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));

const RegisterBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: Email,
  // bcrypt only uses the first 72 bytes, so cap the length rather than silently ignore the rest.
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
});

const LoginBody = z.object({
  email: Email,
  password: z.string().min(1, 'Password is required'),
});

// Slows down password guessing and bulk sign-ups from one address.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (_req, res) => {
    res.status(429).json({
      error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please wait a few minutes and try again.' },
    });
  },
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
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

authRouter.post('/login', authLimiter, async (req, res) => {
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

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: currentUser(req), orgTimezone: config.ORG_TIMEZONE });
});
