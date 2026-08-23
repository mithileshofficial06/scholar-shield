import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { attachSession } from './auth/middleware.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { applicationsRouter } from './routes/applications.js';
import { queueRouter } from './routes/queue.js';

/**
 * An AggregateError — which is what pg throws when a host resolves to both ::1 and
 * 127.0.0.1 and neither accepts — has an empty `message`, so the naive handler
 * returns `{"message": ""}` and tells the developer nothing. Unwrap it.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map(describeError).filter(Boolean);
    return inner.length > 0 ? inner.join('; ') : 'AggregateError with no detail';
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const base = err.message || err.name;
    return code ? `${base} (${code})` : base;
  }
  return String(err);
}

function hasCode(err: unknown, code: string): boolean {
  if (err instanceof AggregateError) return err.errors.some((e) => hasCode(e, code));
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: config.WEB_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(attachSession);

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/applications', applicationsRouter);
  app.use('/queue', queueRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', message: 'No such route.' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // Always log server-side, whatever we choose to tell the client.
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);

    if (hasCode(err, 'ECONNREFUSED')) {
      res.status(503).json({
        error: 'dependency_unavailable',
        message:
          config.NODE_ENV === 'production'
            ? 'A required service is unavailable.'
            : 'Cannot reach Postgres. Start it with `npm run infra:up`.',
      });
      return;
    }

    res.status(500).json({
      error: 'internal_error',
      message: config.NODE_ENV === 'production' ? 'Something went wrong.' : describeError(err),
    });
  });

  return app;
}
