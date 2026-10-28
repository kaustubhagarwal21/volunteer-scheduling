import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { alertsRouter } from './alerts/routes';
import { requireAuth } from './auth/middleware';
import { authRouter } from './auth/routes';
import { config } from './config';
import { dashboardRouter } from './dashboard/routes';
import { errorHandler } from './http/errorHandler';
import { HttpError, notFound } from './http/errors';
import { meRouter, programsRouter } from './programs/routes';
import { shiftsRouter } from './shifts/routes';
import { signupsRouter } from './signups/routes';
import { usersRouter } from './users/routes';

const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

export function createApp() {
  const app = express();

  // The host puts one TLS-terminating proxy in front of us. Trusting exactly one hop makes req.ip
  // the real client address (used by the login rate limiter) without letting clients spoof it.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  if (config.NODE_ENV !== 'test') app.use(requestLogger);

  const api = express.Router();
  api.use(requireJsonForChanges);
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter);

  // Deny by default: every route registered below needs a signed-in user. Coordinator-only routes
  // add requireCoordinator on top; nothing relies on the UI hiding a button.
  api.use(requireAuth);
  api.use('/me', meRouter);
  api.use('/programs', programsRouter);
  api.use('/shifts', shiftsRouter);
  api.use('/signups', signupsRouter);
  api.use('/alerts', alertsRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/users', usersRouter);
  api.use(() => {
    throw notFound('API route');
  });
  app.use('/api', api);

  // In production this same service serves the built React app, so the browser and the API share
  // one origin: the session cookie is first-party and no CORS configuration is needed.
  if (existsSync(CLIENT_DIST)) {
    app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(CLIENT_DIST));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

/**
 * Cross-site request forgery: the session cookie is SameSite=Lax, so browsers don't send it on
 * cross-site POSTs. As a second layer, every state-changing API call must say it is JSON. An HTML
 * form on another site can't send that content type, and a cross-origin script would need a CORS
 * preflight, which this API never grants.
 */
const requireJsonForChanges: express.RequestHandler = (req, _res, next) => {
  const changesState = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (changesState && !req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'JSON_REQUIRED', 'Send this request with Content-Type: application/json.');
  }
  next();
};

const requestLogger: express.RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
};
