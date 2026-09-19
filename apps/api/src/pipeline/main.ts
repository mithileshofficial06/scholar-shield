/**
 * Worker entrypoint — `npm run worker`.
 *
 * A separate process from the API on purpose. OCR is CPU-bound and blocking;
 * running it in the API process makes request latency a function of how many
 * documents are being read at the time.
 */

import { closePool } from '../db.js';
import { startRetentionSchedule } from '../jobs/retention.js';
import { closeQueue } from './queue.js';
import { startWorker } from './worker.js';

const worker = startWorker();

// The retention sweep lives here rather than in the API for the same reason
// OCR does: slow, periodic, and no HTTP request should wait for it.
startRetentionSchedule();

console.log('scholarshield-worker started (pipeline + retention sweep)');

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, draining pipeline worker.`);
  // Let in-flight stages finish: a stage killed mid-write leaves its row in
  // `running` until the stale timeout, delaying that document needlessly.
  await worker.close();
  await closeQueue();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
