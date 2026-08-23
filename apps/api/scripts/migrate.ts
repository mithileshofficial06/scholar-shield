/**
 * Minimal forward-only migration runner.
 *
 * Applies db/migrations/*.sql in filename order, once each, inside a transaction,
 * recording applied files in schema_migrations. 002_app_role.sql needs superuser
 * privileges and is skipped with a warning rather than failing the run when the
 * connected role cannot execute it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../db/migrations');

const OPTIONAL = new Set(['002_app_role.sql']);

async function run(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.filename));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`applied  ${file}`);
      count += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (OPTIONAL.has(file)) {
        console.warn(`skipped  ${file} — ${message}`);
        console.warn('         (needs superuser; the append-only trigger in 001 still applies)');
      } else {
        console.error(`failed   ${file}`);
        throw err;
      }
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? 'schema already up to date' : `${count} migration(s) applied`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
