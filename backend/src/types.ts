// Row shapes mirroring the database schema. Kept intentionally close to the
// SQL so the mapping between code and tables is obvious.

export type JobType =
  | 'immediate'
  | 'delayed'
  | 'scheduled'
  | 'recurring'
  | 'batch';

export type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'canceled';

export interface JobRow {
  id: string;
  queue_id: string;
  type: JobType;
  task: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  available_at: string;
  max_retries: number;
  attempt_count: number;
  claimed_by: string | null;
  claimed_at: string | null;
  locked_until: string | null;
  dedupe_key: string | null;
  batch_id: string | null;
  scheduled_job_id: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerRow {
  id: string;
  name: string | null;
  hostname: string | null;
  status: 'active' | 'idle' | 'draining' | 'dead';
  concurrency: number;
  last_heartbeat_at: string;
  registered_at: string;
  metadata: Record<string, unknown>;
}
