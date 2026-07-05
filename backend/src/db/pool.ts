import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Shared connection pool. Every service (api, worker, scheduler, reaper)
 * imports this so connection handling lives in one place.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number.parseInt(process.env.PG_POOL_MAX ?? '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

/** Thin query helper returning rows with a light generic type. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

/**
 * Run a function inside a single transaction, committing on success and
 * rolling back on any thrown error. The callback receives a dedicated client.
 */
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

/** Wait for Postgres to accept connections (used at service startup). */
export async function waitForDb(retries = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      logger.warn({ attempt }, 'Database not ready yet, retrying...');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
