# Distributed Job Scheduler

A production-inspired distributed job scheduling platform — submit background jobs
over a REST API and have a fleet of workers reliably execute them across multiple
processes/machines, with retries, backoff, scheduling (cron), a Dead Letter Queue,
and a live web dashboard. Conceptually a small, self-hostable **UiPath Orchestrator /
BullMQ / Sidekiq**.

The database is the queue: jobs are claimed atomically with
`SELECT … FOR UPDATE SKIP LOCKED`, so no two workers ever run the same job — no
Redis, no external broker, no distributed-lock service required.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Screenshots](#screenshots)
- [Quick start](#quick-start-docker)
- [Local development](#local-development)
- [Running tests](#running-tests)
- [Project structure](#project-structure)
- [Documentation](#documentation)
- [Tech choices](#tech-choices)

---

## Features

| Area | What's implemented |
|------|--------------------|
| **Auth & tenancy** | JWT auth, organizations, memberships (RBAC roles), projects, project API keys |
| **Queues** | Priority, per-queue concurrency limit, pause/resume, reusable retry policies, live stats |
| **Job types** | Immediate, delayed, scheduled (run-at), recurring (cron), batch |
| **Lifecycle** | `queued → scheduled → claimed → running → completed / failed → retry / dead_letter` |
| **Reliability** | Atomic claiming (`FOR UPDATE SKIP LOCKED`), worker heartbeats + leases, a reaper that reclaims orphaned jobs, graceful shutdown |
| **Retries** | Fixed, linear and exponential backoff (with jitter) + Dead Letter Queue |
| **Observability** | Per-attempt execution records, structured job logs, worker fleet view, throughput metrics |
| **Dashboard** | Overview metrics, queue management, job explorer + detail, worker monitor, DLQ, live polling |
| **Tests** | Concurrency (12 workers / 300 jobs, zero double-claims), retry→DLQ, reaper reclaim |

## Architecture

One backend codebase runs in **four modes** (API, scheduler, reaper, worker) that
map 1:1 to the diagram. The dashboard talks only to the API; every background
process talks only to PostgreSQL, which is both the source of truth and the queue.

<p align="center"><img src="assets/architecture.png" alt="System architecture" width="640"></p>

More detail — data flows and the concurrency model — is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Job lifecycle

A job moves through a small state machine. Failures retry with a backoff delay, and
when they run out of retries they land in the Dead Letter Queue. Every attempt is
recorded as its own row, so the full retry history is kept.

<p align="center"><img src="assets/job_lifecycle.png" alt="Job lifecycle" width="300"></p>

### Data model

13 tables in third normal form, with ownership cascading down
organization → project → queue → job. Filled diamonds mark ownership that cascades
on delete. Full schema and index rationale in **[docs/ER_DIAGRAM.md](docs/ER_DIAGRAM.md)**.

<p align="center"><img src="assets/er_diagram.png" alt="Entity relationship / class diagram" width="720"></p>

## Screenshots

The dashboard polls the API for near real-time updates.

| Overview — metrics & throughput | Job detail — attempts & logs |
|:---:|:---:|
| ![Overview](assets/screenshots/overview.png) | ![Job detail](assets/screenshots/job-detail.png) |
| **Queues** | **Jobs explorer** |
| ![Queues](assets/screenshots/queues.png) | ![Jobs](assets/screenshots/jobs.png) |
| **Workers — live & reaper-detected dead** | **Dead Letter Queue** |
| ![Workers](assets/screenshots/workers.png) | ![Dead Letter](assets/screenshots/dead-letter.png) |

## Quick start (Docker)

Prerequisites: **Docker + Docker Compose**.

```bash
# 1. Configure (defaults work out of the box; host DB port is 5433 to avoid
#    clashing with a local Postgres on 5432).
cp .env.example .env

# 2. Build & start everything (Postgres, migrations, API, scheduler, reaper,
#    a worker, and the dashboard).
docker compose up -d --build

# 3. (Optional) load demo data — a user, project, queues and a spread of jobs.
docker compose run --rm migrate npm run seed

# 4. Open the dashboard
#    http://localhost:5173     login: demo@example.com / password123
#    API:  http://localhost:4000/health
```

Scale the worker fleet to watch jobs distribute across workers:

```bash
docker compose up -d --scale worker=3
```

## Local development

Requires **Node 20+** and a Postgres (the compose one is fine):

```bash
docker compose up -d postgres          # just the database (host port 5433)
export DATABASE_URL="postgres://scheduler:scheduler_pw@localhost:5433/job_scheduler"

# backend
cd backend && npm install
npm run migrate && npm run seed
npm run dev:api          # API on :4000
npm run worker           # in another terminal
npm run scheduler        # in another terminal
npm run reaper           # in another terminal

# frontend
cd ../frontend && npm install
npm run dev              # Vite dev server on :5173 (proxies /api to :4000)
```

## Running tests

```bash
cd backend
export DATABASE_URL="postgres://scheduler:scheduler_pw@localhost:5433/job_scheduler"
npm test
```

The suite covers the parts most likely to break under load:

- **`claim.test.ts`** — 12 workers claim 300 jobs concurrently; asserts **zero
  double-claims**, availability windows are respected, and the retry→DLQ path.
- **`reaper.test.ts`** — lease-expiry requeue, retry-exhaustion dead-lettering,
  and reclaiming a dead worker's in-flight jobs.
- **`retry.test.ts`** — fixed / linear / exponential backoff and the retry cap.

## Project structure

```
├── backend/                 # API + scheduler + reaper + worker (one image, 4 modes)
│   ├── src/
│   │   ├── api/             # Express app, routes, middleware, access control
│   │   ├── worker/          # worker loop + task handlers
│   │   ├── scheduler/       # promotes due jobs, fires cron
│   │   ├── reaper/          # entry point (logic in services/reaper.ts)
│   │   ├── services/        # jobs (claim/complete/fail), reaper — the core logic
│   │   ├── db/              # pool, migration runner, SQL migrations, seed
│   │   └── lib/             # auth, retry, cron, logger, errors
│   └── test/                # vitest suites
├── frontend/                # React + Vite dashboard
├── docs/                    # ARCHITECTURE, ER_DIAGRAM, API, DESIGN_DECISIONS
└── docker-compose.yml
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — system architecture, data flows, job state machine, concurrency model
- **[docs/ER_DIAGRAM.md](docs/ER_DIAGRAM.md)** — entity-relationship diagram, keys, indexes, normalization, cascades
- **[docs/API.md](docs/API.md)** — full REST API reference
- **[docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md)** — major trade-offs and why

## Tech choices

- **PostgreSQL as the queue** — `FOR UPDATE SKIP LOCKED` gives correct, lock-free
  concurrent claiming with a single durable store (no Redis/RabbitMQ to operate).
- **Node + TypeScript** — one language across API, workers and dashboard.
- **Express** — small, explicit HTTP layer; **Zod** for request validation.
- **Raw SQL** (no ORM) — the schema and the critical claim query are front and
  centre where they can be reasoned about.
- **React + Vite** — fast, dependency-light SPA; live updates via polling.
