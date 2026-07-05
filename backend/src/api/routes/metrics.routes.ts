import { Router } from 'express';
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { asyncHandler } from '../http.js';
import { assertProjectAccess } from '../access.js';

export const metricsRouter = Router();

/** High-level project dashboard summary. */
metricsRouter.get(
  '/projects/:projectId/metrics',
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId!;
    await assertProjectAccess(req.userId!, projectId);

    const statusCounts = await query<{ status: string; count: string }>(
      `SELECT j.status, count(*) AS count
       FROM jobs j JOIN queues q ON q.id = j.queue_id
       WHERE q.project_id = $1 GROUP BY j.status`,
      [projectId],
    );

    const throughput = await query<{ completed: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE j.status = 'completed' AND j.updated_at > now() - interval '1 hour') AS completed,
         count(*) FILTER (WHERE j.status IN ('failed','dead_letter') AND j.updated_at > now() - interval '1 hour') AS failed
       FROM jobs j JOIN queues q ON q.id = j.queue_id
       WHERE q.project_id = $1`,
      [projectId],
    );

    const counts = await query<{ queues: string; dlq: string }>(
      `SELECT
         (SELECT count(*) FROM queues WHERE project_id = $1) AS queues,
         (SELECT count(*) FROM dead_letter_queue d JOIN queues q ON q.id = d.queue_id
            WHERE q.project_id = $1) AS dlq`,
      [projectId],
    );

    const workers = await query<{ alive: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE last_heartbeat_at > now() - ($1 || ' seconds')::interval
                            AND status <> 'dead') AS alive,
         count(*) AS total
       FROM workers`,
      [config.reaper.heartbeatTimeoutSeconds],
    );

    const byStatus: Record<string, number> = {};
    for (const r of statusCounts.rows) byStatus[r.status] = Number(r.count);

    res.json({
      jobsByStatus: byStatus,
      lastHour: {
        completed: Number(throughput.rows[0]!.completed),
        failed: Number(throughput.rows[0]!.failed),
      },
      queues: Number(counts.rows[0]!.queues),
      deadLetter: Number(counts.rows[0]!.dlq),
      workers: { alive: Number(workers.rows[0]!.alive), total: Number(workers.rows[0]!.total) },
    });
  }),
);

/** Per-minute throughput for the last hour (for the dashboard chart). */
metricsRouter.get(
  '/projects/:projectId/metrics/throughput',
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId!;
    await assertProjectAccess(req.userId!, projectId);
    const { rows } = await query(
      `SELECT
         date_trunc('minute', je.finished_at) AS minute,
         count(*) FILTER (WHERE je.status = 'succeeded')::int AS completed,
         count(*) FILTER (WHERE je.status = 'failed')::int    AS failed
       FROM job_executions je
       JOIN jobs j   ON j.id = je.job_id
       JOIN queues q ON q.id = j.queue_id
       WHERE q.project_id = $1
         AND je.finished_at > now() - interval '1 hour'
       GROUP BY 1 ORDER BY 1`,
      [projectId],
    );
    res.json({ data: rows });
  }),
);
