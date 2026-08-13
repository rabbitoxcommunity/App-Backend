import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { logger } from './config/logger.js';
import { env } from './config/env.js';
import { tenantContext } from './middleware/tenantContext.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiRouter } from './routes/index.js';

export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: true, // tenant apps are white-label builds (A1) — origin is not the isolation boundary, the JWT/header is (§1.2)
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: express.Request) => (req.headers['x-request-id'] as string) || Math.random().toString(36).slice(2),
      autoLogging: { ignore: (req: express.Request) => req.url === '/health' || req.url === '/ready' },
    }),
  );

  // §23.2 — liveness / readiness, unauthenticated, no tenant context needed.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (_req, res) => {
    const mongoReady = mongoose.connection.readyState === 1;
    res.status(mongoReady ? 200 : 503).json({ mongo: mongoReady });
  });

  app.use(env.API_BASE_PATH, tenantContext, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
