# API Reference

Base URL: `http://localhost:4000`

- All responses are JSON. Errors use `{ "error": { "code, message, details } }`.
- All `/api/*` routes except `/api/auth/*` require `Authorization: Bearer <JWT>`.
- List endpoints support `?page` (default 1) and `?limit` (default 20, max 100).

## Conventions

| Status | Meaning |
|--------|---------|
| 200 / 201 | Success |
| 400 `bad_request` | Validation failed (details include field errors) |
| 401 `unauthorized` | Missing / invalid token |
| 403 `forbidden` | Authenticated but no access to the resource |
| 404 `not_found` | Resource does not exist (or not visible to you) |
| 409 `conflict` | Uniqueness violation (duplicate name / dedupe key) |

---

## Auth

### `POST /api/auth/register`
Creates a user and a default organization they own.
```json
{ "email": "you@example.com", "password": "min8chars", "name": "You", "organizationName": "Acme" }
```
→ `201 { "token", "user": { id, email }, "organizationId" }`

### `POST /api/auth/login`
```json
{ "email": "you@example.com", "password": "..." }
```
→ `200 { "token", "user": { id, email } }`

### `GET /api/auth/me`
→ `200 { "user", "organizations": [{ id, name, role }] }`

---

## Organizations & Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/organizations` | Orgs you belong to |
| `POST` | `/api/organizations` | Create org (`{ name }`) — you become owner |
| `GET` | `/api/projects` | Projects across your orgs (with `queue_count`) |
| `POST` | `/api/projects` | Create project (`{ name, organizationId }`) — returns `api_key` |
| `GET` | `/api/projects/:projectId` | Project detail |

---

## Retry policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects/:projectId/retry-policies` | List |
| `POST` | `/api/projects/:projectId/retry-policies` | Create |

```json
POST body:
{ "name": "Exp x5", "strategy": "exponential",
  "maxRetries": 5, "baseDelaySeconds": 10, "maxDelaySeconds": 3600 }
```
`strategy ∈ { fixed, linear, exponential }`.

---

## Queues

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects/:projectId/queues` | List with live status counts |
| `POST` | `/api/projects/:projectId/queues` | Create |
| `GET` | `/api/queues/:queueId` | Detail |
| `PATCH` | `/api/queues/:queueId` | Update priority / concurrency / retry policy |
| `POST` | `/api/queues/:queueId/pause` | Pause (workers stop claiming from it) |
| `POST` | `/api/queues/:queueId/resume` | Resume |
| `GET` | `/api/queues/:queueId/stats` | Status counts for the queue |
| `GET` | `/api/queues/:queueId/scheduled` | Recurring (cron) definitions |

```json
Create queue body:
{ "name": "emails", "priority": 10, "concurrencyLimit": 5, "retryPolicyId": null }
```

---

## Jobs

### `POST /api/queues/:queueId/jobs` — submit a job
```json
// immediate
{ "type": "immediate", "task": "send_email", "payload": { "to": "a@b.com" }, "priority": 0 }

// delayed (runs in N seconds)
{ "type": "delayed", "task": "send_email", "delaySeconds": 30, "payload": {} }

// scheduled (runs at a timestamp)
{ "type": "scheduled", "task": "report", "runAt": "2026-07-05T09:00:00Z", "payload": {} }

// recurring (creates a cron definition, not an immediate job)
{ "type": "recurring", "task": "send_email", "cronExpr": "*/5 * * * *", "timezone": "UTC", "payload": {} }
```
Optional on any type: `maxRetries` (override), `dedupeKey` (idempotency).
→ `201` with the created `job` (or `scheduled_job` for recurring).

Built-in demo tasks: `send_email`, `http_request`, `sleep`, `flaky`, `always_fail`.

### `POST /api/queues/:queueId/batch` — submit many at once
```json
{ "name": "nightly", "jobs": [ { "task": "send_email", "payload": { "to": "a@b.com" } }, ... ] }
```
→ `201 { "batchId", "count" }`

### `GET /api/projects/:projectId/jobs` — list / filter
Query params: `status`, `queueId`, `task`, `page`, `limit`.
→ `200 { "data": [job…], "pagination": { page, limit, total } }`

### `GET /api/jobs/:jobId` — detail
→ `200 { "job", "executions": [attempt…], "logs": [line…] }`

### `POST /api/jobs/:jobId/retry`
Requeues a `failed` / `dead_letter` job (resets attempts, removes DLQ entry).

### `POST /api/jobs/:jobId/cancel`
Cancels a `queued` / `scheduled` job.

### `GET /api/projects/:projectId/dead-letter`
Paginated Dead Letter Queue for the project.

---

## Workers

### `GET /api/workers`
Fleet view — status, derived `alive` (from heartbeat), `active_jobs`, capacity.

---

## Metrics

### `GET /api/projects/:projectId/metrics`
```json
{ "jobsByStatus": { "queued": 3, "completed": 120, ... },
  "lastHour": { "completed": 42, "failed": 3 },
  "queues": 2, "deadLetter": 1,
  "workers": { "alive": 3, "total": 4 } }
```

### `GET /api/projects/:projectId/metrics/throughput`
Per-minute completed/failed for the last hour (dashboard chart).

---

## Health

### `GET /health`
Unauthenticated liveness + DB readiness probe → `{ "status": "ok", "time" }`.

---

## Example: end-to-end with curl

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}' | jq -r .token)

PID=$(curl -s localhost:4000/api/projects -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')
QID=$(curl -s localhost:4000/api/projects/$PID/queues -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')

curl -s localhost:4000/api/queues/$QID/jobs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"immediate","task":"send_email","payload":{"to":"x@y.com"}}'
```
