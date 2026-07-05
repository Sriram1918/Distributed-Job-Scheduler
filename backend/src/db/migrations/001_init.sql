-- =====================================================================
-- Distributed Job Scheduler — initial schema
-- ---------------------------------------------------------------------
-- Design notes (see docs/DESIGN_DECISIONS.md for full rationale):
--   * UUID primary keys everywhere (gen_random_uuid) so ids can be minted
--     client-side / across shards without coordination.
--   * The `jobs` table doubles as the queue. Jobs are claimed atomically
--     with `SELECT ... FOR UPDATE SKIP LOCKED`, guaranteeing that exactly
--     one worker ever runs a given job even under heavy contention.
--   * A job has MANY executions (one row per attempt) -> retry history is
--     first class, not squashed into the jobs row.
--   * Cascades flow down the ownership tree: org -> project -> queue -> job
--     -> executions/logs, so deleting a project cleans everything under it.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many between users and orgs, carrying the RBAC role.
CREATE TABLE memberships (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id  UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
    org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role     TEXT NOT NULL DEFAULT 'member'
             CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, org_id)
);

CREATE TABLE projects (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    api_key    TEXT NOT NULL UNIQUE,   -- for programmatic job submission
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);

-- ---------------------------------------------------------------------
-- Retry policies (reusable across queues within a project)
-- ---------------------------------------------------------------------
CREATE TABLE retry_policies (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    strategy           TEXT NOT NULL DEFAULT 'exponential'
                       CHECK (strategy IN ('fixed', 'linear', 'exponential')),
    max_retries        INT  NOT NULL DEFAULT 3  CHECK (max_retries >= 0),
    base_delay_seconds INT  NOT NULL DEFAULT 10 CHECK (base_delay_seconds >= 0),
    max_delay_seconds  INT  NOT NULL DEFAULT 3600,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Queues
-- ---------------------------------------------------------------------
CREATE TABLE queues (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    priority          INT  NOT NULL DEFAULT 0,       -- higher = drained first
    concurrency_limit INT  NOT NULL DEFAULT 10 CHECK (concurrency_limit > 0),
    is_paused         BOOLEAN NOT NULL DEFAULT false,
    -- If the policy is deleted, keep the queue but fall back to defaults.
    retry_policy_id   UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- ---------------------------------------------------------------------
-- Workers & heartbeats
-- ---------------------------------------------------------------------
CREATE TABLE workers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT,
    hostname          TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'idle', 'draining', 'dead')),
    concurrency       INT  NOT NULL DEFAULT 5,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata          JSONB NOT NULL DEFAULT '{}'
);

-- Append-only heartbeat history (useful for the dashboard timeline).
CREATE TABLE worker_heartbeats (
    id          BIGSERIAL PRIMARY KEY,
    worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    active_jobs INT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- Batches (a named group of jobs submitted together)
-- ---------------------------------------------------------------------
CREATE TABLE batches (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT,
    total      INT NOT NULL DEFAULT 0,
    completed  INT NOT NULL DEFAULT 0,
    failed     INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Scheduled (recurring / cron) job definitions
-- Each firing materializes a concrete row in `jobs`.
-- ---------------------------------------------------------------------
CREATE TABLE scheduled_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id    UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    name        TEXT,
    cron_expr   TEXT NOT NULL,
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    task        TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}',
    is_active   BOOLEAN NOT NULL DEFAULT true,
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Jobs  (the hot table — also serves as the queue)
-- ---------------------------------------------------------------------
CREATE TABLE jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id         UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    type             TEXT NOT NULL DEFAULT 'immediate'
                     CHECK (type IN ('immediate','delayed','scheduled','recurring','batch')),
    task             TEXT NOT NULL,               -- handler name, e.g. "send_email"
    payload          JSONB NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','scheduled','claimed','running',
                                       'completed','failed','dead_letter','canceled')),
    priority         INT  NOT NULL DEFAULT 0,
    available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- eligible-to-run time
    max_retries      INT  NOT NULL DEFAULT 3,
    attempt_count    INT  NOT NULL DEFAULT 0,
    claimed_by       UUID REFERENCES workers(id) ON DELETE SET NULL,
    claimed_at       TIMESTAMPTZ,
    locked_until     TIMESTAMPTZ,                 -- lease / visibility timeout
    dedupe_key       TEXT,                        -- optional idempotency key
    batch_id         UUID REFERENCES batches(id) ON DELETE CASCADE,
    scheduled_job_id UUID REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
    last_error       TEXT,
    result           JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Job executions — one row per attempt (retry history is first class)
-- ---------------------------------------------------------------------
CREATE TABLE job_executions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id      UUID REFERENCES workers(id) ON DELETE SET NULL,
    attempt_number INT  NOT NULL,
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','succeeded','failed')),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    duration_ms    INT,
    error          TEXT,
    output         JSONB
);

-- ---------------------------------------------------------------------
-- Structured per-job logs
-- ---------------------------------------------------------------------
CREATE TABLE job_logs (
    id           BIGSERIAL PRIMARY KEY,
    job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    execution_id UUID REFERENCES job_executions(id) ON DELETE CASCADE,
    level        TEXT NOT NULL DEFAULT 'info'
                 CHECK (level IN ('debug','info','warn','error')),
    message      TEXT NOT NULL,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Dead Letter Queue — jobs that exhausted retries
-- ---------------------------------------------------------------------
CREATE TABLE dead_letter_queue (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    queue_id   UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    reason     TEXT,
    attempts   INT,
    payload    JSONB,
    failed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Indexes
-- =====================================================================

-- THE claim index: a partial, covering index over exactly the rows the
-- worker's claim query scans. Ordered so the planner can walk it in
-- (priority DESC, available_at ASC) order without a sort.
CREATE INDEX idx_jobs_claim
    ON jobs (queue_id, priority DESC, available_at ASC)
    WHERE status = 'queued';

-- Reaper: quickly find jobs whose lease has expired.
CREATE INDEX idx_jobs_lease
    ON jobs (locked_until)
    WHERE status IN ('claimed', 'running');

-- Scheduler: jobs waiting for their delay/schedule to elapse.
CREATE INDEX idx_jobs_pending_schedule
    ON jobs (available_at)
    WHERE status = 'scheduled';

-- Idempotency: at most one live job per (queue, dedupe_key).
CREATE UNIQUE INDEX idx_jobs_dedupe
    ON jobs (queue_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
      AND status NOT IN ('completed', 'dead_letter', 'canceled');

-- Dashboard / metrics: per-queue status rollups and job explorer filters.
CREATE INDEX idx_jobs_queue_status ON jobs (queue_id, status);
CREATE INDEX idx_jobs_batch        ON jobs (batch_id);
CREATE INDEX idx_jobs_created_at   ON jobs (created_at DESC);

CREATE INDEX idx_executions_job    ON job_executions (job_id, attempt_number);
CREATE INDEX idx_logs_job          ON job_logs (job_id, ts);
CREATE INDEX idx_heartbeats_worker ON worker_heartbeats (worker_id, ts DESC);

-- Reaper: find workers that stopped heartbeating.
CREATE INDEX idx_workers_heartbeat ON workers (last_heartbeat_at)
    WHERE status <> 'dead';

-- Scheduler: due recurring definitions.
CREATE INDEX idx_scheduled_next ON scheduled_jobs (next_run_at)
    WHERE is_active = true;

CREATE INDEX idx_dlq_queue ON dead_letter_queue (queue_id, failed_at DESC);

-- =====================================================================
-- Trigger: keep jobs.updated_at fresh
-- =====================================================================
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
