import { query, withTransaction } from '../db/pool.js';
import { shouldRetry } from '../lib/retry.js';
import type { JobRow } from '../types.js';

/**
 * Reaper logic, kept separate from the process entry point so it can be unit
 * tested directly. These functions are safe to run from multiple reaper
 * replicas concurrently (SKIP LOCKED on the reclaim scan).
 */

/** Declare workers dead if they have not heartbeated within the timeout. */
export async function markDeadWorkers(timeoutSeconds: number): Promise<number> {
  const { rowCount } = await query(
    `UPDATE workers
     SET status = 'dead'
     WHERE status <> 'dead'
       AND last_heartbeat_at < now() - ($1 || ' seconds')::interval`,
    [timeoutSeconds],
  );
  return rowCount ?? 0;
}

/**
 * Reclaim jobs stuck in-flight: either their lease expired (worker crashed
 * without releasing them) or they belong to a worker just declared dead. Each
 * is requeued (retries remaining) or dead-lettered (exhausted).
 */
export async function reclaimOrphans(): Promise<{ requeued: number; deadLettered: number }> {
  return withTransaction(async (c) => {
    const { rows } = await c.query<JobRow>(
      `SELECT j.*
       FROM jobs j
       WHERE j.status IN ('claimed', 'running')
         AND (
           j.locked_until < now()
           OR j.claimed_by IN (SELECT id FROM workers WHERE status = 'dead')
         )
       FOR UPDATE OF j SKIP LOCKED
       LIMIT 100`,
    );

    let requeued = 0;
    let deadLettered = 0;

    for (const job of rows) {
      // Close any execution the lost worker left open.
      await c.query(
        `UPDATE job_executions
         SET status = 'failed', finished_at = now(),
             error = 'reclaimed: worker lost or lease expired'
         WHERE job_id = $1 AND status = 'running'`,
        [job.id],
      );

      if (shouldRetry(job.max_retries, job.attempt_count)) {
        // Infrastructure failure (not the task's fault) -> requeue immediately.
        await c.query(
          `UPDATE jobs
           SET status = 'queued', available_at = now(),
               claimed_by = NULL, claimed_at = NULL, locked_until = NULL,
               last_error = 'reclaimed after worker loss', updated_at = now()
           WHERE id = $1`,
          [job.id],
        );
        requeued++;
      } else {
        await c.query(
          `UPDATE jobs
           SET status = 'dead_letter', claimed_by = NULL, locked_until = NULL,
               last_error = 'reclaimed after worker loss; retries exhausted',
               updated_at = now()
           WHERE id = $1`,
          [job.id],
        );
        await c.query(
          `INSERT INTO dead_letter_queue (job_id, queue_id, reason, attempts, payload)
           VALUES ($1, $2, $3, $4, $5)`,
          [job.id, job.queue_id, 'worker loss; retries exhausted', job.attempt_count, job.payload],
        );
        deadLettered++;
      }
    }
    return { requeued, deadLettered };
  });
}
