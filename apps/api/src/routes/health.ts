import { Router } from 'express';
import { healthcheck } from '../db.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'scholarshield-api' });
});

/** Readiness — reports dependency state without failing the process. */
healthRouter.get('/ready', async (_req, res) => {
  const database = await healthcheck();
  res.status(database ? 200 : 503).json({
    status: database ? 'ready' : 'degraded',
    checks: { database },
  });
});
