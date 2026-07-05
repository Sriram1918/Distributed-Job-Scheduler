import { config } from '../config.js';
import { pool, waitForDb, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { nextCronRun } from '../lib/cron.js';

process.env.SERVICE_NAME = 'scheduler';
const log = logger.child({ component: 'scheduler' });

/**
 * Promote jobs whose scheduled/delayed time has arrived: `scheduled` -> `queued`.
 * After this, the normal claim path (which only sees `queued` rows that are
 * available_at <= now()) picks them up.
 */
async function promoteDueJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
     SET status = 'queued', updated_at = now()
     WHERE status = 'scheduled' AND available_at <= now()`,
  );
  return rowCount ?? 0;
}

/**
 * Materialize recurring (cron) definitions that are due. Each due definition
 * produces one concrete job and advances its next_run_at. We lock rows with
 * SKIP LOCKED so running multiple scheduler replicas never double-fires.
 */
async function fireRecurring(): Promise<number> {
  return withTransaction(async (c) => {
    const { rows } = await c.query<{
      id: string;
      queue_id: string;
      task: string;
      payload: Record<string, unknown>;
      cron_expr: string;
      timezone: string;
      next_run_at: string | null;
    }>(
      `SELECT id, queue_id, task, payload, cron_expr, timezone, next_run_at
       FROM scheduled_jobs
       WHERE is_active = true
         AND (next_run_at IS NULL OR next_run_at <= now())
       FOR UPDATE SKIP LOCKED`,
    );

    let fired = 0;
    for (const def of rows) {
      // A brand-new definition (next_run_at NULL) just gets its first run time
      // computed; it does not fire retroactively.
      if (def.next_run_at !== null) {
        await c.query(
          `INSERT INTO jobs (queue_id, type, task, payload, status, scheduled_job_id)
           VALUES ($1, 'recurring', $2, $3, 'queued', $4)`,
          [def.queue_id, def.task, def.payload, def.id],
        );
        fired++;
      }
      const next = nextCronRun(def.cron_expr, def.timezone, new Date());
      await c.query(
        `UPDATE scheduled_jobs
         SET last_run_at = CASE WHEN $2::timestamptz IS NULL THEN last_run_at ELSE now() END,
             next_run_at = $3::timestamptz
         WHERE id = $1`,
        [def.id, def.next_run_at, next],
      );
    }
    return fired;
  });
}

async function tick(): Promise<void> {
  try {
    const promoted = await promoteDueJobs();
    const fired = await fireRecurring();
    if (promoted > 0 || fired > 0) {
      log.info({ promoted, fired }, 'Scheduler tick');
    }
  } catch (err) {
    log.error({ err }, 'Scheduler tick failed');
  }
}

async function main(): Promise<void> {
  await waitForDb();
  log.info({ intervalMs: config.scheduler.intervalMs }, 'Scheduler started');

  let running = true;
  const loop = async () => {
    while (running) {
      await tick();
      await new Promise((r) => setTimeout(r, config.scheduler.intervalMs));
    }
  };
  void loop();

  const shutdown = async () => {
    running = false;
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  log.error({ err }, 'Scheduler failed to start');
  process.exit(1);
});
