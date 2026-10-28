import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { isProduction } from '../config';
import type { Queryable } from '../db/pool';
import type { AuthUser } from './types';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Only the hash is stored, so the sessions table alone cannot be used to forge a cookie. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Queryable, userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Housekeeping: drop this user's expired sessions whenever they sign in again.
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()', [userId]);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(token),
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function findSessionUser(db: Queryable, token: string): Promise<AuthUser | null> {
  const { rows } = await db.query<AuthUser>(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

const cookieOptions: CookieOptions = {
  httpOnly: true, // not readable from JavaScript, so an XSS bug cannot steal the session
  sameSite: 'lax', // not sent on cross-site POST/PATCH/DELETE, which is our CSRF protection
  secure: isProduction, // HTTPS-only in production
  path: '/',
};

export function setSessionCookie(res: Response, session: { token: string; expiresAt: Date }): void {
  res.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}
