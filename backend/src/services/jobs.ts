import type pg from 'pg';
import { pool, query } from '../db/pool.js';
import type { JobRow } from '../types.js';
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffSeconds,
  shouldRetry,
  type RetryPolicy,
} from '../lib/retry.js';

/**
 * Atomically claim up to `limit` runnable jobs for a worker.
 *
 * This is the heart of the whole system. `FOR UPDATE ... SKIP LOCKED` lets
 * many workers hammer the same queues concurrently: each worker locks the
 * candidate rows it reads and SKIPS any rows another worker already locked,
 * so no two workers ever claim the same job — without a global lock and
 * without blocking. The claim also:
 *   - respects available_at (delayed/scheduled jobs aren't visible early),
 *   - honours queue pause,
 *   - enforces per-queue concurrency (best-effort — see DESIGN_DECISIONS.md),
 *   - orders by queue priority, then job priority, then FIFO,
 *   - stamps a lease (locked_until) so a crashed worker's jobs can be reclaimed,
 *   - bumps attempt_count so retries are counted from the moment work begins.
 *
 * @param queueIds  restrict to these queues, or null for "any queue".
 */
export async function claimJobs(
  workerId: string,
  limit: number,
  leaseSeconds: number,
  queueIds: string[] | null = null,
  client: pg.PoolClient | { query: typeof pool.query } = pool,
): Promise<JobRow[]> {
  const sql = `
    WITH claimable AS (
      SELECT j.id
      FROM jobs j
      JOIN queues q ON q.id = j.queue_id
      WHERE j.status = 'queued'
        AND j.available_at <= now()
        AND q.is_paused = false
        AND ($4::uuid[] IS NULL OR j.queue_id = ANY($4))
        AND (
          SELECT count(*) FROM jobs r
          WHERE r.queue_id = j.queue_id
            AND r.status IN ('claimed', 'running')
        ) < q.concurrency_limit
      ORDER BY q.priority DESC, j.priority DESC, j.available_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT $2
    )
    UPDATE jobs j
    SET status        = 'claimed',
        claimed_by    = $1,
        claimed_at    = now(),
        locked_until  = now() + ($3 || ' seconds')::interval,
        attempt_count = j.attempt_count + 1,
        updated_at    = now()
    FROM claimable c
    WHERE j.id = c.id
    RETURNING j.*;
  `;
  const res = await client.query(sql, [workerId, limit, leaseSeconds, queueIds]);
  return res.rows as JobRow[];
}

/**
 * Transition a claimed job into RUNNING and open an execution record for the
 * current attempt. Returns the execution id.
 */
export async function startExecution(
  client: pg.PoolClient,
  job: JobRow,
  workerId: string,
): Promise<string> {
  await client.query(
    `UPDATE jobs SET status = 'running', updated_at = now() WHERE id = $1`,
    [job.id],
  );
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO job_executions (job_id, worker_id, attempt_number, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING id`,
    [job.id, workerId, job.attempt_count],
  );
  return rows[0]!.id;
}

/** Mark an execution and its job as completed successfully. */
export async function completeJob(
  client: pg.PoolClient,
  job: JobRow,
  executionId: string,
  output: unknown,
  durationMs: number,
): Promise<void> {
  await client.query(
    `UPDATE job_executions
     SET status = 'succeeded', finished_at = now(),
         duration_ms = $2, output = $3
     WHERE id = $1`,
    [executionId, durationMs, output ?? null],
  );
  await client.query(
    `UPDATE jobs
     SET status = 'completed', result = $2, locked_until = NULL,
         last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [job.id, output ?? null],
  );
  if (job.batch_id) {
    await client.query(
      `UPDATE batches SET completed = completed + 1 WHERE id = $1`,
      [job.batch_id],
    );
  }
}

/**
 * Mark an execution failed, then either schedule a retry (with backoff) or
 * move the job to the Dead Letter Queue when retries are exhausted.
 */
export async function failJob(
  client: pg.PoolClient,
  job: JobRow,
  executionId: string,
  errorMessage: string,
  durationMs: number,
  policy: RetryPolicy,
): Promise<{ retried: boolean; delaySeconds?: number }> {
  await client.query(
    `UPDATE job_executions
     SET status = 'failed', finished_at = now(),
         duration_ms = $2, error = $3
     WHERE id = $1`,
    [executionId, durationMs, errorMessage],
  );

  // attempt_count already includes this attempt (bumped at claim time).
  const attempt = job.attempt_count;

  if (shouldRetry(job.max_retries, attempt)) {
    const delaySeconds = computeBackoffSeconds(policy, attempt);
    await client.query(
      `UPDATE jobs
       SET status = 'queued',
           available_at = now() + ($2 || ' seconds')::interval,
           claimed_by = NULL, claimed_at = NULL, locked_until = NULL,
           last_error = $3, updated_at = now()
       WHERE id = $1`,
      [job.id, delaySeconds, errorMessage],
    );
    return { retried: true, delaySeconds };
  }

  // Retries exhausted -> dead letter.
  await client.query(
    `UPDATE jobs
     SET status = 'dead_letter', claimed_by = NULL, locked_until = NULL,
         last_error = $2, updated_at = now()
     WHERE id = $1`,
    [job.id, errorMessage],
  );
  await client.query(
    `INSERT INTO dead_letter_queue (job_id, queue_id, reason, attempts, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [job.id, job.queue_id, errorMessage, attempt, job.payload],
  );
  if (job.batch_id) {
    await client.query(
      `UPDATE batches SET failed = failed + 1 WHERE id = $1`,
      [job.batch_id],
    );
  }
  return { retried: false };
}

/** Fetch the effective retry policy for a job's queue (or the default). */
export async function getRetryPolicyForQueue(queueId: string): Promise<RetryPolicy> {
  const { rows } = await query<RetryPolicy>(
    `SELECT rp.strategy, rp.max_retries, rp.base_delay_seconds, rp.max_delay_seconds
     FROM queues q
     JOIN retry_policies rp ON rp.id = q.retry_policy_id
     WHERE q.id = $1`,
    [queueId],
  );
  return rows[0] ?? DEFAULT_RETRY_POLICY;
}

/** Append a structured log line for a job. */
export async function logJob(
  client: pg.PoolClient | typeof pool,
  jobId: string,
  executionId: string | null,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
): Promise<void> {
  await client.query(
    `INSERT INTO job_logs (job_id, execution_id, level, message)
     VALUES ($1, $2, $3, $4)`,
    [jobId, executionId, level, message],
  );
}
