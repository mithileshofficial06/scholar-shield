import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { attachSession } from './auth/middleware.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { applicationsRouter } from './routes/applications.js';
import { queueRouter } from './routes/queue.js';

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
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const message = config.NODE_ENV === 'production' ? 'Something went wrong.' : err.message;
    res.status(500).json({ error: 'internal_error', message });
  });

  return app;
}
