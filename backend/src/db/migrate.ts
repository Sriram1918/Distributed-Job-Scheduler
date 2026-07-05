import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, waitForDb } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Minimal, dependency-free migration runner. Applies every *.sql file in
 * ./migrations (in lexical order) exactly once, tracked in schema_migrations.
 * Each file runs inside its own transaction, so a failed migration rolls back
 * cleanly and can be retried.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function run(): Promise<void> {
  await waitForDb();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      logger.info({ file }, 'Applied migration');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ file, err }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ applied: count, total: files.length }, 'Migrations complete');
  await pool.end();
}

run().catch((err) => {
  logger.error({ err }, 'Migration runner crashed');
  process.exit(1);
});
