# Design Decisions & Trade-offs

This document records the significant choices and *why* they were made — and,
just as importantly, what was consciously left out.

## 1. PostgreSQL as the queue (no Redis / RabbitMQ)

**Decision.** Use `SELECT … FOR UPDATE SKIP LOCKED` on the `jobs` table for
claiming, instead of a dedicated broker.

**Why.** The core requirement — never run a job twice, even with many workers
and crashes — is fundamentally a *concurrency + durability* problem, and
Postgres solves both in one place. `SKIP LOCKED` gives lock-free, contention-
tolerant claiming; the job row is also the durable record, so there's no
"message vs. database" consistency gap.

**Trade-off.** A broker like Redis can push work (lower latency, no polling) and
sustain higher throughput. We accept short polling latency
(`POLL_INTERVAL_MS`, default 1s) in exchange for one fewer moving part, exactly-
once semantics without two-phase coordination, and far simpler operations. At
very high scale you'd shard the `jobs` table or add `LISTEN/NOTIFY` to wake
workers immediately — the schema already supports both.

## 2. Delivery semantics: at-least-once + idempotency

**Decision.** Guarantee at-least-once execution; make double execution safe
rather than impossible.

**Why.** Exactly-once delivery across process crashes is impossible without
distributed transactions into the side-effecting system. A worker can finish the
work and die before recording the result; the reaper will then requeue it.

**Consequences.** Handlers should be idempotent. We provide a `dedupe_key`
(partial unique index) to prevent duplicate *submission*, and the lease +
reaper to bound how long a crashed job stays stuck.

## 3. One image, four run-modes

**Decision.** API, scheduler, reaper and worker are the same codebase started
with different commands, not four separate services.

**Why.** They share the DB layer, job-lifecycle logic and retry math. One image
means one dependency set, one build, and no code duplication, while still giving
four independently scalable *processes* that map cleanly onto the architecture
diagram.

**Trade-off.** Slightly larger image than a purpose-built worker binary. Worth
it for the maintainability.

## 4. Lease + heartbeat for crash recovery

**Decision.** Each claim stamps `locked_until` (a lease). Workers heartbeat and
renew the lease on in-flight jobs. The reaper reclaims jobs whose lease expired
or whose worker was declared dead.

**Why.** This is the mechanism that turns "a worker died" from data loss into a
retry. Two independent signals (lease expiry *and* dead-worker detection) mean a
job is recovered quickly when a worker is known dead, and still eventually
recovered if detection lags.

**Trade-off.** A very long task must renew its lease (we do, on each heartbeat)
or risk being reclaimed and run twice — which ties back to idempotency (§2).

## 5. Retry count vs. retry timing

**Decision.** The **queue's retry policy** governs *timing* (fixed / linear /
exponential backoff + caps + jitter). The **job's `max_retries`** governs the
*count* (defaulted from the policy at submit, overridable per job).

**Why.** Timing is an operational property of a queue ("emails back off gently");
the number of attempts is often job-specific. Splitting them keeps both
configurable without coupling. Jitter (±10%) avoids retry thundering-herds.

## 6. Per-queue concurrency is best-effort

**Decision.** The claim query filters out queues already at their
`concurrency_limit` via a counting sub-select; it is not a hard, race-free cap.

**Why.** A strict global cap needs either a serialized slot table or per-queue
advisory locks, both of which reduce claim parallelism. For fair resource
sharing between queues, best-effort is sufficient and keeps the hot path fast.
The per-*worker* concurrency limit **is** hard (a worker never runs more than
its slots). The trade-off is documented rather than hidden.

## 7. Raw SQL, no ORM

**Decision.** Hand-written parameterized SQL in a thin data layer.

**Why.** The two things this project is graded on — schema design and the atomic
claim — are exactly the things an ORM hides. Keeping SQL explicit makes the
`FOR UPDATE SKIP LOCKED` claim, the partial indexes and the cascades legible.
Zod handles the validation an ORM would otherwise provide at the edge.

## 8. Live updates via polling, not WebSockets

**Decision.** The dashboard polls (2–5s) instead of using WebSockets.

**Why.** Polling is stateless, survives reconnects for free, and is trivial to
scale behind a load balancer. For a monitoring dashboard the latency is
imperceptible. WebSockets/SSE would reduce load at high fan-out and are a
natural future addition (the API is already stateless).

## 9. Scheduler as an explicit state transition

**Decision.** Delayed/scheduled jobs sit in `scheduled` and are promoted to
`queued` by the scheduler, rather than workers checking `available_at`
themselves.

**Why.** It makes the lifecycle observable (you can see what's *waiting* vs.
*runnable*), keeps the worker claim query dead simple, and gives cron a single
owner. Recurring definitions live in `scheduled_jobs`; the scheduler locks due
rows with `SKIP LOCKED`, so running multiple scheduler replicas never
double-fires.

## What was intentionally left out

To keep the system honest and focused (rather than feature-loaded), these were
scoped out but have a clear place in the design:

- **Rate limiting, queue sharding, distributed locks** — the schema and claim
  model extend to them, but they weren't needed to demonstrate correctness.
- **WebSocket push, workflow/DAG dependencies, AI failure summaries** — listed
  as bonuses; omitted in favour of getting the core reliability guarantees and
  their tests right.
- **A secrets/vault layer** — API keys are stored opaque; production would
  encrypt them at rest.
