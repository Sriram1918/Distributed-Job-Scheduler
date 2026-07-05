import express, { type Express } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger.js';
import { query } from '../db/pool.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { asyncHandler } from './http.js';
import { authRouter } from './routes/auth.routes.js';
import { projectsRouter } from './routes/projects.routes.js';
import { queuesRouter } from './routes/queues.routes.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { workersRouter } from './routes/workers.routes.js';
import { metricsRouter } from './routes/metrics.routes.js';

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  // Liveness + DB readiness probe (unauthenticated).
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      await query('SELECT 1');
      res.json({ status: 'ok', time: new Date().toISOString() });
    }),
  );

  // Public auth endpoints.
  app.use('/api/auth', authRouter);

  // Everything else requires a valid JWT.
  app.use('/api', requireAuth, projectsRouter);
  app.use('/api', requireAuth, queuesRouter);
  app.use('/api', requireAuth, jobsRouter);
  app.use('/api', requireAuth, workersRouter);
  app.use('/api', requireAuth, metricsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
