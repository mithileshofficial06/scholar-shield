import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

/**
 * Return SQL `date` columns as 'YYYY-MM-DD' strings, not JS Dates.
 *
 * node-postgres parses a date into a Date at *local* midnight. Every consumer
 * here treats dates as calendar strings — the rules build `${date}T00:00:00Z` —
 * and a Date interpolates as "Thu Jul 23 2026 ... GMT+0530", which parses to NaN
 * and made DEADLINE_PROXIMITY skip every application without a word. Converting
 * the Date back instead would shift the day for any timezone east of UTC.
 */
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value) => value);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type QueryParam = string | number | boolean | null | Date | object;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Run a set of statements in one transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function healthcheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
