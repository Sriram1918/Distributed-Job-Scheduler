import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, parse } from '../http.js';
import { assertProjectAccess, assertQueueAccess } from '../access.js';

export const queuesRouter = Router();

// ---- Retry policies (project-scoped, reusable across queues) --------------

const retryPolicySchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(['fixed', 'linear', 'exponential']).default('exponential'),
  maxRetries: z.number().int().min(0).max(50).default(3),
  baseDelaySeconds: z.number().int().min(0).default(10),
  maxDelaySeconds: z.number().int().min(1).default(3600),
});

queuesRouter.get(
  '/projects/:projectId/retry-policies',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const { rows } = await query(
      `SELECT * FROM retry_policies WHERE project_id = $1 ORDER BY created_at`,
      [req.params.projectId],
    );
    res.json({ data: rows });
  }),
);

queuesRouter.post(
  '/projects/:projectId/retry-policies',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const b = parse(retryPolicySchema, req.body);
    const { rows } = await query(
      `INSERT INTO retry_policies
         (project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.projectId, b.name, b.strategy, b.maxRetries, b.baseDelaySeconds, b.maxDelaySeconds],
    );
    res.status(201).json(rows[0]);
  }),
);

// ---- Queues ---------------------------------------------------------------

const createQueueSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().default(0),
  concurrencyLimit: z.number().int().min(1).max(1000).default(10),
  retryPolicyId: z.string().uuid().nullable().optional(),
});

/** List queues in a project, each with a live status breakdown. */
queuesRouter.get(
  '/projects/:projectId/queues',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const { rows } = await query(
      `SELECT q.*,
              coalesce(s.queued, 0)    AS queued,
              coalesce(s.running, 0)   AS running,
              coalesce(s.completed, 0) AS completed,
              coalesce(s.failed, 0)    AS failed,
              coalesce(s.dead, 0)      AS dead_letter
       FROM queues q
       LEFT JOIN LATERAL (
         SELECT
           count(*) FILTER (WHERE status = 'queued')                 AS queued,
           count(*) FILTER (WHERE status IN ('claimed','running'))   AS running,
           count(*) FILTER (WHERE status = 'completed')              AS completed,
           count(*) FILTER (WHERE status = 'failed')                 AS failed,
           count(*) FILTER (WHERE status = 'dead_letter')            AS dead
         FROM jobs WHERE jobs.queue_id = q.id
       ) s ON true
       WHERE q.project_id = $1
       ORDER BY q.priority DESC, q.created_at`,
      [req.params.projectId],
    );
    res.json({ data: rows });
  }),
);

queuesRouter.post(
  '/projects/:projectId/queues',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const b = parse(createQueueSchema, req.body);
    const { rows } = await query(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit, retry_policy_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.projectId, b.name, b.priority, b.concurrencyLimit, b.retryPolicyId ?? null],
    );
    res.status(201).json(rows[0]);
  }),
);

queuesRouter.get(
  '/queues/:queueId',
  asyncHandler(async (req, res) => {
    await assertQueueAccess(req.userId!, req.params.queueId!);
    const { rows } = await query(`SELECT * FROM queues WHERE id = $1`, [req.params.queueId]);
    res.json(rows[0]);
  }),
);

const updateQueueSchema = z.object({
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().min(1).max(1000).optional(),
  retryPolicyId: z.string().uuid().nullable().optional(),
});

queuesRouter.patch(
  '/queues/:queueId',
  asyncHandler(async (req, res) => {
    await assertQueueAccess(req.userId!, req.params.queueId!);
    const b = parse(updateQueueSchema, req.body);
    const { rows } = await query(
      `UPDATE queues SET
         priority          = COALESCE($2, priority),
         concurrency_limit = COALESCE($3, concurrency_limit),
         retry_policy_id   = COALESCE($4, retry_policy_id)
       WHERE id = $1 RETURNING *`,
      [req.params.queueId, b.priority ?? null, b.concurrencyLimit ?? null, b.retryPolicyId ?? null],
    );
    res.json(rows[0]);
  }),
);

const setPaused = (paused: boolean) =>
  asyncHandler(async (req, res) => {
    await assertQueueAccess(req.userId!, req.params.queueId!);
    const { rows } = await query(
      `UPDATE queues SET is_paused = $2 WHERE id = $1 RETURNING id, name, is_paused`,
      [req.params.queueId, paused],
    );
    res.json(rows[0]);
  });

queuesRouter.post('/queues/:queueId/pause', setPaused(true));
queuesRouter.post('/queues/:queueId/resume', setPaused(false));

/** Detailed status counts for a single queue. */
queuesRouter.get(
  '/queues/:queueId/stats',
  asyncHandler(async (req, res) => {
    await assertQueueAccess(req.userId!, req.params.queueId!);
    const { rows } = await query(
      `SELECT status, count(*)::int AS count
       FROM jobs WHERE queue_id = $1 GROUP BY status`,
      [req.params.queueId],
    );
    const stats: Record<string, number> = {};
    for (const r of rows as { status: string; count: number }[]) stats[r.status] = r.count;
    res.json({ queueId: req.params.queueId, stats });
  }),
);
