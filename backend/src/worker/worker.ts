import os from 'node:os';
import { pool, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { JobRow } from '../types.js';
import {
  claimJobs,
  completeJob,
  failJob,
  getRetryPolicyForQueue,
  logJob,
  startExecution,
} from '../services/jobs.js';
import { getTaskHandler } from './tasks.js';

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  name?: string;
}

/**
 * A single worker process. Polls for work, claims it atomically, and runs up
 * to `concurrency` jobs at once. Sends heartbeats so the reaper knows it is
 * alive, and renews the lease on in-flight jobs so long-running work is not
 * reclaimed out from under it.
 */
export class Worker {
  private workerId!: string;
  private active = 0; // jobs currently executing
  private draining = false;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly log = logger.child({ component: 'worker' });

  constructor(private readonly opts: WorkerOptions) {}

  async start(): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (name, hostname, status, concurrency)
       VALUES ($1, $2, 'active', $3)
       RETURNING id`,
      [this.opts.name ?? `worker-${process.pid}`, os.hostname(), this.opts.concurrency],
    );
    this.workerId = rows[0]!.id;
    this.log.info({ workerId: this.workerId, concurrency: this.opts.concurrency }, 'Worker registered');

    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.opts.heartbeatIntervalMs);
    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs);
  }

  /** One polling tick: fill free slots with freshly claimed jobs. */
  private async pollOnce(): Promise<void> {
    if (this.draining) return;
    try {
      const free = this.opts.concurrency - this.active;
      if (free > 0) {
        const claimed = await claimJobs(this.workerId, free, this.opts.leaseSeconds);
        for (const job of claimed) {
          this.active++;
          void this.process(job).finally(() => {
            this.active--;
          });
        }
      }
    } catch (err) {
      this.log.error({ err }, 'Poll cycle failed');
    } finally {
      if (!this.draining) this.scheduleNextPoll(this.opts.pollIntervalMs);
    }
  }

  /** Execute one job through its full lifecycle. */
  private async process(job: JobRow): Promise<void> {
    const startedAt = Date.now();
    const jobLog = this.log.child({ jobId: job.id, task: job.task, attempt: job.attempt_count });

    // 1. Transition to RUNNING and open an execution record.
    let executionId: string;
    try {
      executionId = await withTransaction((c) => startExecution(c, job, this.workerId));
    } catch (err) {
      jobLog.error({ err }, 'Failed to start execution');
      return;
    }

    const log = (msg: string) => logJob(pool, job.id, executionId, 'info', msg);

    // 2. Run the handler OUTSIDE any transaction (work can be slow).
    const handler = getTaskHandler(job.task);
    try {
      if (!handler) throw new Error(`No handler registered for task "${job.task}"`);
      const output = await handler(job.payload, {
        jobId: job.id,
        attempt: job.attempt_count,
        log,
      });
      // 3a. Success.
      await withTransaction((c) => completeJob(c, job, executionId, output, Date.now() - startedAt));
      jobLog.info({ ms: Date.now() - startedAt }, 'Job completed');
    } catch (err) {
      // 3b. Failure -> retry or dead-letter.
      const message = err instanceof Error ? err.message : String(err);
      const policy = await getRetryPolicyForQueue(job.queue_id);
      const outcome = await withTransaction((c) =>
        failJob(c, job, executionId, message, Date.now() - startedAt, policy),
      );
      await logJob(pool, job.id, executionId, 'error', message);
      if (outcome.retried) {
        jobLog.warn({ delaySeconds: outcome.delaySeconds }, 'Job failed, retry scheduled');
      } else {
        jobLog.error('Job failed permanently, moved to dead letter queue');
      }
    }
  }

  /** Heartbeat: prove liveness and renew leases on in-flight jobs. */
  private async heartbeat(): Promise<void> {
    try {
      await pool.query(
        `UPDATE workers
         SET last_heartbeat_at = now(),
             status = CASE WHEN $2 THEN 'draining' ELSE 'active' END
         WHERE id = $1`,
        [this.workerId, this.draining],
      );
      await pool.query(
        `INSERT INTO worker_heartbeats (worker_id, active_jobs) VALUES ($1, $2)`,
        [this.workerId, this.active],
      );
      // Extend the lease on anything we're still running so the reaper leaves it alone.
      await pool.query(
        `UPDATE jobs
         SET locked_until = now() + ($2 || ' seconds')::interval
         WHERE claimed_by = $1 AND status IN ('claimed', 'running')`,
        [this.workerId, this.opts.leaseSeconds],
      );
    } catch (err) {
      this.log.error({ err }, 'Heartbeat failed');
    }
  }

  /**
   * Graceful shutdown: stop claiming new work, wait for in-flight jobs to
   * finish (up to a timeout), mark ourselves dead, and let the reaper reclaim
   * anything still stuck.
   */
  async shutdown(timeoutMs = 25_000): Promise<void> {
    this.log.info({ active: this.active }, 'Draining worker...');
    this.draining = true;
    clearTimeout(this.pollTimer);

    const deadline = Date.now() + timeoutMs;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    clearInterval(this.heartbeatTimer);
    try {
      await pool.query(`UPDATE workers SET status = 'dead' WHERE id = $1`, [this.workerId]);
    } catch {
      /* best effort */
    }
    this.log.info({ remaining: this.active }, 'Worker stopped');
  }

  get id(): string {
    return this.workerId;
  }
}
