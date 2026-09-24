import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
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
 * IT RUNS AGAINST ITS OWN DATABASE, AND THAT IS NOT A DETAIL
 * ----------------------------------------------------------
 * These tests truncate between cases. Pointed at `DATABASE_URL` they truncate
 * the DEVELOPER'S database — which is exactly what happened the first time this
 * suite was run after it was written, silently destroying a seeded corpus
 * somebody was working with.
 *
 * So the database name is rewritten here, before anything imports `db.ts` and
 * reads the connection string, and `helpers.ts` refuses to truncate a database
 * whose name does not end in `_test`. Two independent guards, because one of
 * them is a convention and conventions are what get overridden in a hurry.
 *
 * Single-threaded and sequential: the tests share one schema, so running them
 * in parallel would have them delete each other's rows.
 */

// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/…", which
// dotenv cannot open — and with `quiet` it says nothing, so the defaults
// silently took over and pointed the suite at whatever held port 5432.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const DEFAULT_URL = 'postgresql://scholarshield:scholarshield@localhost:5432/scholarshield';

/** `…/scholarshield` becomes `…/scholarshield_test`, preserving everything else. */
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  const name = url.pathname.replace(/^\//, '') || 'scholarshield';
  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return url.toString();
}

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
    env: {
      DATABASE_URL: testDatabaseUrl(),
    },
  },
});
