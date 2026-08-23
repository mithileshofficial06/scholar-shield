import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db.js';

const app = createApp();

const server = app.listen(config.API_PORT, () => {
  console.log(
    `scholarshield-api listening on http://localhost:${config.API_PORT} (${config.NODE_ENV})`,
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down.`);
  server.close(() => {
    void closePool().then(() => process.exit(0));
  });
  // Don't hang forever on in-flight requests.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
