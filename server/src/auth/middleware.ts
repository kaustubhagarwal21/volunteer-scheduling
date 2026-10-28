import type { Request, RequestHandler } from 'express';
import { pool } from '../db/pool';
import { forbidden, unauthenticated } from '../http/errors';
import { findSessionUser, SESSION_COOKIE } from './sessions';
import type { AuthUser } from './types';

/** Rejects the request with 401 unless it carries a valid session cookie; sets req.user. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  const user = typeof token === 'string' ? await findSessionUser(pool, token) : null;
  if (!user) throw unauthenticated();
  req.user = user;
  next();
};

/** Must run after requireAuth. Role checks happen here on the server, not just in the UI. */
export const requireCoordinator: RequestHandler = (req, _res, next) => {
  if (currentUser(req).role !== 'coordinator') {
    throw forbidden('Only coordinators can do that.');
  }
  next();
};

/** The signed-in user for a route behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
