import { defineConfig } from 'vitest/config';

/**
 * The integration suite (PROJECT_REPORT.md §13).
 *
 *     npm run test:integration
 *
 * Needs a live Postgres with migrations applied. It deliberately does NOT skip
 * itself when the database is missing: a suite that quietly passes when it
 * cannot run is how "every stage handler is idempotent" stayed an unverified
 * claim for the life of the project.
 *
 * Single-threaded and sequential. These tests share one schema and truncate
 * between cases, so running them in parallel would have them delete each
 * other's rows.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    reporters: ['verbose'],
    fileParallelism: false,
    sequence: { concurrent: false },
    // OCR stubs are fast, but claiming a stale stage waits on a real clock.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
