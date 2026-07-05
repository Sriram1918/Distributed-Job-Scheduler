import { Router } from 'express';
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { asyncHandler } from '../http.js';

export const workersRouter = Router();

/**
 * Fleet view. Workers are cluster-wide infrastructure (not project-scoped),
 * so any authenticated user can see the pool. `alive` is derived from the
 * heartbeat freshness using the same timeout the reaper uses.
 */
workersRouter.get(
  '/workers',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT w.id, w.name, w.hostname, w.status, w.concurrency,
              w.last_heartbeat_at, w.registered_at,
              (w.last_heartbeat_at > now() - ($1 || ' seconds')::interval) AS alive,
              (SELECT count(*)::int FROM jobs j
                 WHERE j.claimed_by = w.id AND j.status IN ('claimed','running')) AS active_jobs
       FROM workers w
       ORDER BY w.status <> 'dead' DESC, w.registered_at DESC`,
      [config.reaper.heartbeatTimeoutSeconds],
    );
    res.json({ data: rows });
  }),
);
