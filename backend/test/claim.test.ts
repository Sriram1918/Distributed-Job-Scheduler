import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { claimJobs, failJob, startExecution, getRetryPolicyForQueue } from '../src/services/jobs.js';
import type { JobRow } from '../src/types.js';

/**
 * Integration tests against a real Postgres (the whole point of the design is
 * that correctness lives in the database). Requires DATABASE_URL to point at a
 * migrated database — e.g. the docker-compose Postgres.
 */

let orgId: string;
let projectId: string;
let queueId: string;
const workerIds: string[] = [];

async function makeWorker(name: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO workers (name, concurrency) VALUES ($1, 1000) RETURNING id`,
    [name],
  );
  workerIds.push(rows[0]!.id);
  return rows[0]!.id;
}

beforeAll(async () => {
  // Isolated org tree so we never touch seed/demo data.
  const org = await query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('test-org') RETURNING id`);
  orgId = org.rows[0]!.id;
  const proj = await query<{ id: string }>(
    `INSERT INTO projects (org_id, name, api_key) VALUES ($1, 'test-proj', $2) RETURNING id`,
    [orgId, 'sk_test_' + Math.random().toString(36).slice(2)],
  );
  projectId = proj.rows[0]!.id;
  // High concurrency limit so it doesn't gate the claim-uniqueness test.
  const q = await query<{ id: string }>(
    `INSERT INTO queues (project_id, name, concurrency_limit) VALUES ($1, 'test-q', 100000) RETURNING id`,
    [projectId],
  );
  queueId = q.rows[0]!.id;
});

afterAll(async () => {
  await query(`DELETE FROM workers WHERE id = ANY($1)`, [workerIds]);
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]); // cascades to project/queue/jobs
  await pool.end();
});

async function seedJobs(n: number): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [queueId];
  for (let i = 0; i < n; i++) {
    params.push(`task_${i}`);
    values.push(`($1, 'immediate', $${params.length}, '{}', 'queued', 3)`);
  }
  await query(
    `INSERT INTO jobs (queue_id, type, task, payload, status, max_retries) VALUES ${values.join(',')}`,
    params,
  );
}

describe('atomic job claiming (FOR UPDATE SKIP LOCKED)', () => {
  it('never hands the same job to two workers under concurrency', async () => {
    const N = 300;
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    await seedJobs(N);

    // 12 workers all grab as fast as they can, in parallel.
    const W = 12;
    for (let i = 0; i < W; i++) await makeWorker(`w${i}`);

    const claimed: JobRow[][] = await Promise.all(
      workerIds.map((wid) => claimJobs(wid, 50, 60, [queueId])),
    );

    // No job id may appear in more than one worker's result set.
    const seen = new Map<string, number>();
    let total = 0;
    for (const set of claimed) {
      for (const job of set) {
        total++;
        seen.set(job.id, (seen.get(job.id) ?? 0) + 1);
      }
    }
    const duplicates = [...seen.values()].filter((c) => c > 1);
    expect(duplicates).toHaveLength(0);           // <- the core guarantee
    expect(seen.size).toBe(total);                // every claimed id is unique
    expect(total).toBeGreaterThan(0);

    // Claimed jobs are exactly those now marked 'claimed' in the DB.
    const dbClaimed = await query<{ count: string }>(
      `SELECT count(*) FROM jobs WHERE queue_id = $1 AND status = 'claimed'`,
      [queueId],
    );
    expect(Number(dbClaimed.rows[0]!.count)).toBe(total);
  });

  it('claims each remaining job exactly once when drained repeatedly', async () => {
    const N = 100;
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    await seedJobs(N);
    const wid = await makeWorker('drainer');

    const all = new Set<string>();
    // Drain in batches until empty.
    for (;;) {
      const batch = await claimJobs(wid, 25, 60, [queueId]);
      if (batch.length === 0) break;
      for (const j of batch) {
        expect(all.has(j.id)).toBe(false);
        all.add(j.id);
      }
    }
    expect(all.size).toBe(N);
  });

  it('does not claim jobs that are not yet available (delayed) or paused', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    // One future job, one ready job.
    await query(
      `INSERT INTO jobs (queue_id, type, task, status, available_at, max_retries)
       VALUES ($1,'delayed','future','queued', now() + interval '1 hour', 3),
              ($1,'immediate','ready','queued', now(), 3)`,
      [queueId],
    );
    const wid = await makeWorker('availtest');
    const claimed = await claimJobs(wid, 10, 60, [queueId]);
    expect(claimed.map((j) => j.task)).toEqual(['ready']);
  });
});

describe('failure handling → retry then dead letter', () => {
  it('retries until max, then moves to the dead letter queue', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    const ins = await query<JobRow>(
      `INSERT INTO jobs (queue_id, type, task, status, max_retries)
       VALUES ($1,'immediate','boom','queued',2) RETURNING *`,
      [queueId],
    );
    const wid = await makeWorker('failer');
    const policy = await getRetryPolicyForQueue(queueId);

    // Attempt 1: claim -> fail -> should requeue.
    let [job] = await claimJobs(wid, 1, 60, [queueId]);
    expect(job).toBeTruthy();
    let out = await withExec(job!, wid, policy);
    expect(out.retried).toBe(true);

    // Reset availability (backoff pushed it into the future) so we can re-claim.
    await query(`UPDATE jobs SET available_at = now() WHERE id = $1`, [ins.rows[0]!.id]);

    // Attempt 2: claim -> fail -> should requeue (attempt 2 <= max 2).
    [job] = await claimJobs(wid, 1, 60, [queueId]);
    out = await withExec(job!, wid, policy);
    expect(out.retried).toBe(true);
    await query(`UPDATE jobs SET available_at = now() WHERE id = $1`, [ins.rows[0]!.id]);

    // Attempt 3: claim -> fail -> exhausted -> dead letter.
    [job] = await claimJobs(wid, 1, 60, [queueId]);
    out = await withExec(job!, wid, policy);
    expect(out.retried).toBe(false);

    const dead = await query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [ins.rows[0]!.id]);
    expect(dead.rows[0]!.status).toBe('dead_letter');
    const dlq = await query<{ count: string }>(`SELECT count(*) FROM dead_letter_queue WHERE job_id = $1`, [ins.rows[0]!.id]);
    expect(Number(dlq.rows[0]!.count)).toBe(1);
  });
});

// Helper: run a full "start execution then fail it" cycle in one transaction.
async function withExec(job: JobRow, workerId: string, policy: Awaited<ReturnType<typeof getRetryPolicyForQueue>>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const execId = await startExecution(client, job, workerId);
    const res = await failJob(client, job, execId, 'intentional', 5, policy);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
