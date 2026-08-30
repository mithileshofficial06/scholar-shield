import { Router } from 'express';
import { healthcheck } from '../db.js';
import { health as ocrHealth } from '../pipeline/ocrClient.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'scholarshield-api' });
});

/**
 * Readiness — reports dependency state without failing the process.
 *
 * The OCR service is reported as three states, not two. `degraded` means the
 * process is up but Tesseract did not resolve, which is the failure worth
 * naming: the pipeline will keep feeding a service that reads nothing, and
 * every document comes back with empty fields rather than an error.
 */
healthRouter.get('/ready', async (_req, res) => {
  const [database, ocr] = await Promise.all([healthcheck(), ocrHealth()]);

  const ocrState = ocr === null ? 'unreachable' : ocr.status;
  const ready = database && ocrState === 'ok';

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    checks: {
      database,
      ocr: ocrState,
      tesseractVersion: ocr?.tesseractVersion ?? null,
    },
  });
});
