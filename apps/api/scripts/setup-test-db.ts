/**
 * Create the integration suite's own database, and migrate it.
 *
 *     npm run test:integration:setup
 *
 * The integration tests truncate between cases. Run against `DATABASE_URL` they
 * truncate whatever the developer is working with — which is not hypothetical:
 * it destroyed a seeded corpus the first time the suite ran after it was
 * written, while reporting sixteen passing tests.
 *
 * So they get their own database, named after the real one with `_test`
 * appended, and `helpers.ts` refuses to run anywhere whose name does not end
 * that way. This script is what brings that database into existence.
 *
 * Safe to re-run: it creates the database only if missing, and the migration
 * runner is already forward-only and idempotent.
 */

import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

// config.ts freezes DATABASE_URL at import time, and db.ts builds its pool from
// that. Importing either here would pin this process to the DEVELOPER's
// database before the rewrite below could take effect — which silently ran the
// migrations against the wrong one. So the environment is read directly, and
// both modules are imported only after DATABASE_URL points at the test database.
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });

const DEFAULT_URL = 'postgresql://scholarshield:scholarshield@localhost:5432/scholarshield';

/** `…/scholarshield` -> `…/scholarshield_test`, preserving host, auth and params. */
function testUrl(source: string): { url: string; name: string } {
  const url = new URL(source);
  const base = url.pathname.replace(/^\//, '') || 'scholarshield';
  const name = base.endsWith('_test') ? base : `${base}_test`;
  url.pathname = `/${name}`;
  return { url: url.toString(), name };
}

async function run(): Promise<void> {
  const { url, name } = testUrl(
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_URL,
  );

  // CREATE DATABASE cannot run inside a transaction and cannot target the
  // database you are connected to, so this connects to `postgres` instead.
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();

  try {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [name],
    );

    if (rows[0]?.exists) {
      console.log(`  database ${name} already exists`);
    } else {
      // The name comes from a connection string in this process's own
      // environment, not from user input, but it is still interpolated into
      // DDL — so it is quoted as an identifier rather than concatenated raw.
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`  created database ${name}`);
    }
  } finally {
    await client.end();
  }

  // Only now, with the environment pointing at the test database, is the
  // migration runner loaded — it reads DATABASE_URL through config.ts at import
  // time and there is no second chance to change its mind.
  process.env.DATABASE_URL = url;
  console.log(`  applying migrations to ${name}...`);
  await import('../src/migrate.js');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
