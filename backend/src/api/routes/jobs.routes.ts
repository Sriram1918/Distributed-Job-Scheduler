import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { isValidCron, nextCronRun } from '../../lib/cron.js';
import { asyncHandler, pagination, parse } from '../http.js';
import { assertProjectAccess, assertQueueAccess } from '../access.js';

export const jobsRouter = Router();

/** Effective retry cap: explicit override, else the queue policy's max, else 3. */
async function effectiveMaxRetries(queueId: string, override?: number): Promise<number> {
  if (typeof override === 'number') return override;
  const { rows } = await query<{ max_retries: number }>(
    `SELECT rp.max_retries
     FROM queues q JOIN retry_policies rp ON rp.id = q.retry_policy_id
     WHERE q.id = $1`,
    [queueId],
  );
  return rows[0]?.max_retries ?? 3;
}

const submitSchema = z.object({
  type: z.enum(['immediate', 'delayed', 'scheduled', 'recurring']).default('immediate'),
  task: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
  maxRetries: z.number().int().min(0).max(50).optional(),
  dedupeKey: z.string().min(1).optional(),
  // delayed
  delaySeconds: z.number().int().min(0).optional(),
  // scheduled
  runAt: z.string().datetime().optional(),
  // recurring
  cronExpr: z.string().optional(),
  timezone: z.string().default('UTC'),
});

/** Submit a single job (immediate / delayed / scheduled / recurring). */
jobsRouter.post(
  '/queues/:queueId/jobs',
  asyncHandler(async (req, res) => {
    await assertQueueAccess(req.userId!, req.params.queueId!);
    const b = parse(submitSchema, req.body);
    const queueId = req.params.queueId!;

    // Recurring jobs are cron *definitions*, not concrete jobs.
    if (b.type === 'recurring') {
      if (!b.cronExpr || !isValidCron(b.cronExpr)) throw badRequest('Valid cronExpr is required for recurring jobs');
      const next = nextCronRun(b.cronExpr, b.timezone, new Date());
      const { rows } = await query(
        `INSERT INTO scheduled_jobs (queue_id, name, cron_expr, timezone, task, payload, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [queueId, b.task, b.cronExpr, b.timezone, b.task, b.payload, next],
      );
      res.status(201).json({ kind: 'scheduled_job', ...rows[0]! });
      return;
    }

    // Compute initial status + availability window.
    let status: 'queued' | 'scheduled' = 'queued';
    let availableAt = new Date();
    if (b.type === 'delayed') {
      if (b.delaySeconds === undefined) throw badRequest('delaySeconds is required for delayed jobs');
      availableAt = new Date(Date.now() + b.delaySeconds * 1000);
      status = 'scheduled';
    } else if (b.type === 'scheduled') {
      if (!b.runAt) throw badRequest('runAt is required for scheduled jobs');
      availableAt = new Date(b.runAt);
      status = availableAt.getTime() <= Date.now() ? 'queued' : 'scheduled';
    }

    const maxRetries = await effectiveMaxRetries(queueId, b.maxRetries);
    const { rows } = await query(
      `INSERT INTO jobs
         (queue_id, type, task, payload, status, priority, available_at, max_retries, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [queueId, b.type, b.task, b.payload, status, b.priority, availableAt, maxRetries, b.dedupeKey ?? null],
    );
    res.status(201).json({ kind: 'job', ...rows[0]! });
  }),
);

const batchSchema = z.object({
  name: z.string().optional(),
  jobs: z
    .array(
      z.object({
        task: z.string().min(1),
        payload: z.record(z.unknown()).default({}),
        priority: z.number().int().default(0),
        maxRetries: z.number().int().min(0).max(50).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

/** Submit a batch of jobs atomically under one batch record. */
jobsRouter.post(
  '/queues/:queueId/batch',
  asyncHandler(async (req, res) => {
    const queue = await assertQueueAccess(req.userId!, req.params.queueId!);
    const b = parse(batchSchema, req.body);
    const defaultMax = await effectiveMaxRetries(queue.id);

    const result = await withTransaction(async (c) => {
      const batch = await c.query<{ id: string }>(
        `INSERT INTO batches (project_id, name, total) VALUES ($1, $2, $3) RETURNING id`,
        [queue.project_id, b.name ?? null, b.jobs.length],
      );
      const batchId = batch.rows[0]!.id;
      for (const j of b.jobs) {
        await c.query(
          `INSERT INTO jobs (queue_id, type, task, payload, status, priority, max_retries, batch_id)
           VALUES ($1, 'batch', $2, $3, 'queued', $4, $5, $6)`,
          [queue.id, j.task, j.payload, j.priority, j.maxRetries ?? defaultMax, batchId],
        );
      }
      return { batchId, count: b.jobs.length };
    });
    res.status(201).json(result);
  }),
);

// ---- Reads ----------------------------------------------------------------

const listFilters = z.object({
  status: z.string().optional(),
  queueId: z.string().uuid().optional(),
  task: z.string().optional(),
});

/** List jobs across a project with filtering + pagination. */
jobsRouter.get(
  '/projects/:projectId/jobs',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const f = parse(listFilters, req.query);
    const { limit, offset, page } = pagination(req.query);

    const where: string[] = ['q.project_id = $1'];
    const params: unknown[] = [req.params.projectId];
    if (f.status) { params.push(f.status); where.push(`j.status = $${params.length}`); }
    if (f.queueId) { params.push(f.queueId); where.push(`j.queue_id = $${params.length}`); }
    if (f.task) { params.push(f.task); where.push(`j.task = $${params.length}`); }

    const whereSql = where.join(' AND ');
    const totalRes = await query<{ count: string }>(
      `SELECT count(*) FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE ${whereSql}`,
      params,
    );
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT j.id, j.queue_id, q.name AS queue_name, j.type, j.task, j.status,
              j.priority, j.attempt_count, j.max_retries, j.available_at,
              j.last_error, j.created_at, j.updated_at
       FROM jobs j JOIN queues q ON q.id = j.queue_id
       WHERE ${whereSql}
       ORDER BY j.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({
      data: rows,
      pagination: { page, limit, total: Number(totalRes.rows[0]!.count) },
    });
  }),
);

/** Full job detail: the job, its execution attempts, and its logs. */
jobsRouter.get(
  '/jobs/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = req.params.jobId!;
    const jobRes = await query(
      `SELECT j.*, q.name AS queue_name, q.project_id
       FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = $1`,
      [jobId],
    );
    const job = jobRes.rows[0] as { project_id: string } | undefined;
    if (!job) throw notFound('Job not found');
    await assertProjectAccess(req.userId!, job.project_id);

    const executions = await query(
      `SELECT id, worker_id, attempt_number, status, started_at, finished_at, duration_ms, error, output
       FROM job_executions WHERE job_id = $1 ORDER BY attempt_number`,
      [jobId],
    );
    const logs = await query(
      `SELECT id, execution_id, level, message, ts FROM job_logs
       WHERE job_id = $1 ORDER BY ts LIMIT 500`,
      [jobId],
    );
    res.json({ job, executions: executions.rows, logs: logs.rows });
  }),
);

/** Manually retry a failed / dead-lettered job (reset it back to queued). */
jobsRouter.post(
  '/jobs/:jobId/retry',
  asyncHandler(async (req, res) => {
    const jobId = req.params.jobId!;
    const jobRes = await query<{ project_id: string; status: string }>(
      `SELECT q.project_id, j.status FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = $1`,
      [jobId],
    );
    const job = jobRes.rows[0];
    if (!job) throw notFound('Job not found');
    await assertProjectAccess(req.userId!, job.project_id);
    if (!['failed', 'dead_letter'].includes(job.status)) {
      throw badRequest(`Only failed or dead-letter jobs can be retried (current: ${job.status})`);
    }
    const { rows } = await query(
      `UPDATE jobs
       SET status = 'queued', available_at = now(), attempt_count = 0,
           claimed_by = NULL, claimed_at = NULL, locked_until = NULL,
           last_error = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [jobId],
    );
    await query(`DELETE FROM dead_letter_queue WHERE job_id = $1`, [jobId]);
    res.json(rows[0]);
  }),
);

/** Cancel a job that has not started yet. */
jobsRouter.post(
  '/jobs/:jobId/cancel',
  asyncHandler(async (req, res) => {
    const jobId = req.params.jobId!;
    const jobRes = await query<{ project_id: string }>(
      `SELECT q.project_id FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = $1`,
      [jobId],
    );
    if (!jobRes.rows[0]) throw notFound('Job not found');
    await assertProjectAccess(req.userId!, jobRes.rows[0].project_id);
    const { rows } = await query(
      `UPDATE jobs SET status = 'canceled', updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'scheduled') RETURNING *`,
      [jobId],
    );
    if (!rows[0]) throw badRequest('Only queued or scheduled jobs can be canceled');
    res.json(rows[0]);
  }),
);

/** Dead Letter Queue for a project. */
jobsRouter.get(
  '/projects/:projectId/dead-letter',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const { limit, offset, page } = pagination(req.query);
    const { rows } = await query(
      `SELECT d.*, j.task, q.name AS queue_name
       FROM dead_letter_queue d
       JOIN jobs j   ON j.id = d.job_id
       JOIN queues q ON q.id = d.queue_id
       WHERE q.project_id = $1
       ORDER BY d.failed_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.projectId, limit, offset],
    );
    res.json({ data: rows, pagination: { page, limit } });
  }),
);

/** Recurring (cron) definitions for a queue. */
jobsRouter.get(
  '/queues/:queueId/scheduled',
  asyncHandler(async (req, res) => {
    await assertQueueAccess(req.userId!, req.params.queueId!);
    const { rows } = await query(
      `SELECT * FROM scheduled_jobs WHERE queue_id = $1 ORDER BY created_at DESC`,
      [req.params.queueId],
    );
    res.json({ data: rows });
  }),
);
