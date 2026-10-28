import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes';
import { config } from './config';
import { errorHandler } from './http/errorHandler';
import { notFound } from './http/errors';
import { shiftsRouter } from './shifts/routes';
import { signupsRouter } from './signups/routes';

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
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter);
  api.use('/shifts', shiftsRouter);
  api.use('/signups', signupsRouter);
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

const requestLogger: express.RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
};
