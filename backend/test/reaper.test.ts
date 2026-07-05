import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { claimJobs } from '../src/services/jobs.js';
import { markDeadWorkers, reclaimOrphans } from '../src/services/reaper.js';

let orgId: string;
let queueId: string;
let workerId: string;

beforeAll(async () => {
  const org = await query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('reaper-org') RETURNING id`);
  orgId = org.rows[0]!.id;
  const proj = await query<{ id: string }>(
    `INSERT INTO projects (org_id, name, api_key) VALUES ($1,'reaper-proj',$2) RETURNING id`,
    [orgId, 'sk_reap_' + Math.random().toString(36).slice(2)],
  );
  const q = await query<{ id: string }>(
    `INSERT INTO queues (project_id, name, concurrency_limit) VALUES ($1,'rq',100000) RETURNING id`,
    [proj.rows[0]!.id],
  );
  queueId = q.rows[0]!.id;
  const w = await query<{ id: string }>(`INSERT INTO workers (name, concurrency) VALUES ('reaper-w', 10) RETURNING id`);
  workerId = w.rows[0]!.id;
});

afterAll(async () => {
  await query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await pool.end();
});

describe('reaper: reclaiming orphaned jobs', () => {
  it('requeues a job whose lease expired (worker crashed mid-run)', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    const ins = await query<{ id: string }>(
      `INSERT INTO jobs (queue_id, task, status, max_retries) VALUES ($1,'t','queued',3) RETURNING id`,
      [queueId],
    );
    const jobId = ins.rows[0]!.id;

    const [claimed] = await claimJobs(workerId, 1, 60, [queueId]);
    expect(claimed!.id).toBe(jobId);
    expect(claimed!.status).toBe('claimed');

    // Simulate the worker dying: its lease lapses.
    await query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [jobId]);

    const res = await reclaimOrphans();
    expect(res.requeued).toBe(1);
    const after = await query<{ status: string; claimed_by: string | null }>(
      `SELECT status, claimed_by FROM jobs WHERE id = $1`, [jobId],
    );
    expect(after.rows[0]!.status).toBe('queued');
    expect(after.rows[0]!.claimed_by).toBeNull();
  });

  it('dead-letters an orphaned job that has exhausted its retries', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    const ins = await query<{ id: string }>(
      `INSERT INTO jobs (queue_id, task, status, max_retries) VALUES ($1,'t','queued',1) RETURNING id`,
      [queueId],
    );
    const jobId = ins.rows[0]!.id;
    await claimJobs(workerId, 1, 60, [queueId]);
    // Simulate it already consumed its retries, then the worker crashed.
    await query(`UPDATE jobs SET attempt_count = 2, locked_until = now() - interval '1 second' WHERE id = $1`, [jobId]);

    const res = await reclaimOrphans();
    expect(res.deadLettered).toBe(1);
    const after = await query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(after.rows[0]!.status).toBe('dead_letter');
    const dlq = await query<{ count: string }>(`SELECT count(*) FROM dead_letter_queue WHERE job_id = $1`, [jobId]);
    expect(Number(dlq.rows[0]!.count)).toBe(1);
  });

  it('reclaims in-flight jobs of a worker declared dead (even before lease expiry)', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    const ins = await query<{ id: string }>(
      `INSERT INTO jobs (queue_id, task, status, max_retries) VALUES ($1,'t','queued',3) RETURNING id`,
      [queueId],
    );
    const jobId = ins.rows[0]!.id;
    // Long lease so only the dead-worker path can trigger reclaim.
    await claimJobs(workerId, 1, 3600, [queueId]);

    // Force the worker's heartbeat stale, then mark it dead via the reaper.
    await query(`UPDATE workers SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [workerId]);
    const dead = await markDeadWorkers(30);
    expect(dead).toBeGreaterThanOrEqual(1);

    const res = await reclaimOrphans();
    expect(res.requeued).toBe(1);
    const after = await query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(after.rows[0]!.status).toBe('queued');

    // Restore worker liveness for any subsequent runs.
    await query(`UPDATE workers SET status = 'active', last_heartbeat_at = now() WHERE id = $1`, [workerId]);
  });
});
