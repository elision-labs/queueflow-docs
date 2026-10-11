---
title: Troubleshooting
description: Symptoms, causes, and fixes for the problems people hit most often. Startup refusals, 401 versus 403, jobs stuck pending, expired leases, slow wake-ups behind PgBouncer, a blank Swagger UI, and CORS warnings.
---

Each section starts with what you see, then why, then what to do. Log lines are quoted as the 0.2.0 server emits them.

## The server refuses to start

**Symptom.** `queueflow serve` exits immediately with:

```text
refusing to serve the API without credentials: set --jwt-secret or --api-keys (QUEUEFLOW_JWT_SECRET / QUEUEFLOW_API_KEYS) and --worker-token (QUEUEFLOW_WORKER_TOKEN). For local development only, pass --dev (QUEUEFLOW_DEV=1) to run with the placeholder tenant and open worker endpoints.
```

**Cause.** Since 0.2.0 the API fails closed. In `api` or `all` mode it needs a tenant credential source (`--api-keys` and/or `--jwt-secret`) **and** a `--worker-token`, or an explicit `--dev`. The message lists exactly which of the two is missing.

**Fix.** For a laptop: add `--dev`. For anything reachable: configure both credentials, for example

```bash
queueflow serve --api-keys "$(openssl rand -hex 24):acme" --worker-token "$(openssl rand -hex 24)"
```

`--mode worker` has no HTTP API and is not subject to the check. If you set the credentials as environment variables, confirm they are reaching the process (`QUEUEFLOW_API_KEYS`, `QUEUEFLOW_JWT_SECRET`, `QUEUEFLOW_WORKER_TOKEN`); an empty string counts as unset. See [Fail-closed startup](/concepts/auth#fail-closed-startup).

**Related.** A startup error mentioning `--api-keys` and `is not 'token:tenant'` means an entry in the list lacks the colon or has an empty side. The format is `token:tenant,token2:tenant2`.

## 401 versus 403

Both mean the request was rejected by authentication, but they say different things.

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | No `Authorization: Bearer …` header, an empty token, or a token that matches nothing configured. On a non-`--dev` server with no tenant credentials configured, every tenant route is `401`. |
| `403` | `{"error":"access denied"}` | You authenticated, but with the wrong class of credential, or for someone else's resource. |

The `403` cases:

- **A tenant token on a worker route** (`POST /api/v1/queues/{queue}/lease`, or `/heartbeat`, `/complete`, `/fail` under `/api/v1/jobs/{id}`). The spec describes this as "Authenticated, but not with the worker credential". Fix: configure the SDK's worker credential (`workerToken` in TypeScript, `worker_token=` in Python, a second client configuration in Go and Rust) with the server's `--worker-token`. Without it the SDKs reuse the tenant token, which only works against a `--dev` server.
- **The worker token on a tenant route** (`POST /api/v1/jobs`, `GET /api/v1/workflows`, and so on). Infrastructure credentials do not get a tenant identity. Fix: use a tenant API key or JWT for application calls.
- **Another tenant's resource**: fetching, cancelling, or replaying a job, workflow, schedule, or dead letter that belongs to a different tenant.

The `401` cases that surprise people:

- A JWT whose `exp` has passed, or signed with a different secret, or using an algorithm other than HS256.
- `--api-keys` edited on disk but the server not restarted; keys are read at startup.
- A token sent as `Authorization: <token>` without the `Bearer ` prefix.

The SDK worker runtimes treat `401` and `403` on the lease call as fatal and throw rather than retrying, so a worker that exits immediately with one of these has a credential problem, not a connectivity problem. See [Authentication and tenants](/concepts/auth).

## Jobs stay `pending`

**Symptom.** `GET /api/v1/jobs?status=pending` grows, `GET /api/v1/stats` shows nothing completing, and no worker logs anything.

Work through these in order.

1. **Is the job claimable yet?** A job with a future `scheduled_at` (created with `run_at`, or waiting on retry backoff as `retrying`) is invisible to workers until then. Check `scheduled_at` on the job.

2. **Is anything leasing from that queue?** Jobs are claimed per queue name. A job created with `"config": {"queue": "images"}` sits until something leases from `images`. Remote workers lease from one queue per run loop (`qf.worker.run("images", …)`, `qf.run_worker("images", …)`), so check that one is pointed at exactly this name; `image` and `images` are different queues.

3. **Are you expecting the server's in-process workers to take it?** In 0.2.0 the in-process workers started by `--mode all` or `--mode worker` drain only the `--default-queue` (`default` unless changed), and only for handlers compiled into the binary (`echo`, `log`, `sleep`, `fail` in the stock build, listed by `GET /api/v1/tasks`). A job on any other queue needs a remote worker. A job on the default queue whose `task_name` matches no in-process handler is dead-lettered with reason `handler_not_found`, so it will not stay `pending`; if it does, nothing is running workers at all.

4. **Is a worker-capable process running?** `--mode api` runs no workers, no janitor, and no cron. An `api`-only fleet needs at least one `--mode worker` or `--mode all` process for in-process handlers and for lease recovery.

5. **Workflow steps** always run on the default queue, regardless of any `queue` you might expect. If steps stay `pending`, put a worker on the default queue. See [Scheduling](/concepts/workflows#scheduling).

6. **Did the worker get a `401`/`403`?** The SDK runtimes exit on those; check the worker's own output.

A quick view of what is waiting where:

```sql
SELECT queue_name, task_name, count(*), min(scheduled_at)
  FROM queueflow.jobs
 WHERE status IN ('pending','retrying') AND scheduled_at <= now()
 GROUP BY 1, 2;
```

## Jobs are redelivered, or `409` on complete

**Symptom.** A handler runs, then runs again; or `POST /api/v1/jobs/{id}/complete` (or `/fail`, `/heartbeat`) returns `409`; or `delivery_count` on the job is larger than `retry_count + 1`.

**Cause.** The lease expired. A worker leases a job for `lease_secs` (default 30) and must heartbeat before that passes. If it does not, the janitor, which sweeps every 5 seconds (default `interval`), reclaims the job: it is briefly re-leased for 60 seconds while it is routed through the normal failure policy, then scheduled for retry if budget remains or dead-lettered with reason `max_attempts_exceeded`. Each reclaim consumes one unit of retry budget. The old `lease_token` is now stale, so any later call presenting it is `409`: the server owns the outcome, and the worker should stop and report nothing.

Common reasons the heartbeat did not arrive:

- A hand-rolled worker that does not heartbeat at all, or heartbeats only the job it is currently processing while holding others from a `max_jobs > 1` lease. Heartbeat every job you hold, at about half the lease interval.
- A handler that blocks the event loop or the interpreter (CPU-bound work in Node, a long synchronous call that starves the Python heartbeat thread).
- A worker process that was killed or lost its network. This is the expected path; the job is retried.
- `lease_secs` too short for the handler's startup time. The SDK default of 30 seconds with a 15 second heartbeat is fine for most work; raise `leaseSecs` / `lease_secs` if the first heartbeat cannot be sent that quickly.

**Fix.** Make the handler idempotent (it must be anyway), heartbeat correctly, and treat a `409` or a non-`running` heartbeat status as "stop". The SDK runtimes do all three. See [Timeouts](/concepts/retries#timeouts) and [The janitor](/internals#the-janitor).

**Also.** A `409` from `POST /api/v1/jobs/{id}/cancel` means the job already finished; from `POST /api/v1/dlq/{id}/replay` it means the entry was already replayed once; from `POST /api/v1/cron` it means a schedule with that name already exists for your tenant.

## Workers wake up slowly behind PgBouncer

**Symptom.** Jobs are picked up, but each one waits up to 5 seconds on an otherwise idle queue, and the server logs:

```text
LISTEN connection failed; waiters fall back to bounded polling
```

or `LISTEN failed; waiters fall back to bounded polling`.

**Cause.** Idle in-process workers and long-polling lease requests normally wake from a PostgreSQL `NOTIFY` fired by an insert trigger. `LISTEN` needs a session, and a pooler in transaction mode (PgBouncer `pool_mode = transaction`, and some managed poolers) does not provide one. The server keeps retrying the listener in the background and the waiters sleep out their bounded wait instead: the 5 second safety poll for in-process workers, or the request's `wait_secs` for a lease. Nothing is lost; wake-up is just late.

**Fix, if the latency matters.** Point QueueFlow at Postgres directly or through a session-mode pool, or give it its own session-mode PgBouncer pool while the application keeps transaction mode. If a 5 second idle latency is acceptable, leave it; throughput under load is unaffected because busy workers do not wait for notifications. See [Waking workers](/internals#waking-workers-listennotify).

## Swagger UI is blank

**Symptom.** `http://localhost:8000/docs` loads an empty page, or the browser console shows failed requests to `unpkg.com`.

**Cause.** The server serves a minimal HTML page that loads `swagger-ui-dist@5` from the unpkg CDN. In an environment without internet access, or behind a proxy that blocks `unpkg.com`, the UI cannot load. The API itself is unaffected.

**Fix.** Use the spec directly: `GET /openapi.json` is served by the same process and needs no CDN, or read the generated [REST API reference](/api) on this site, or point a local Swagger UI or Redoc at `/openapi.json`. Both `/docs` and `/openapi.json` are unauthenticated.

## CORS warnings and browser errors

**Symptom.** At startup:

```text
no --cors-origins / QUEUEFLOW_CORS_ORIGINS configured: CORS is permissive. Restrict it before exposing this API to browsers.
```

**Cause.** With `--cors-origins` unset, the API answers CORS preflights for any origin. That is convenient for a laptop and wrong for a deployment that browsers can reach.

**Fix.** Set the exact origins that may call the API:

```bash
queueflow serve --cors-origins "https://app.example.com,https://admin.example.com"
```

**Related.** `ignoring invalid CORS origin` means one entry did not parse as an origin. Entries are scheme plus host plus optional port, with no path or trailing slash: `https://app.example.com`, not `https://app.example.com/`. If a browser then reports a CORS failure, compare the page's origin (including scheme and port) with the configured list character for character. If browsers never call the API, the warning is informational; it only appears in `api` and `all` mode.

## Development-mode warnings in production logs

**Symptom.**

```text
--dev: development mode is ON. Never expose this server: any non-empty token authenticates as tenant 'tenant1' and the worker-protocol endpoints accept any authenticated token
```

**Cause.** `--dev` was passed or `QUEUEFLOW_DEV` is set (to anything truthy) in the environment, perhaps inherited from a Compose file or a base image.

**Fix.** Remove it and configure real credentials. The server will then refuse to start until they are present, which is the intended check. See the [security checklist](/deployment#security-checklist).

## Cron schedules do not fire

- **No `worker`- or `all`-mode process is running.** The scheduler lives there, not in `api` mode.
- **The schedule is paused.** `enabled` is `false` on the record; `POST /api/v1/cron/{id}/resume`.
- **The expression is in local time.** Expressions are UTC. `0 9 * * *` fires at 09:00 UTC.
- **You expected catch-up.** A long outage produces one catch-up firing, not one per missed slot, and occurrences missed while paused are not replayed on resume.
- **The firing happened but the job did not run.** Firings are ordinary jobs on the schedule's queue; see [Jobs stay pending](#jobs-stay-pending).

See [Firing semantics](/concepts/cron#firing-semantics).

## `GET /health` returns 503

The process is up but cannot reach the database. Check `DATABASE_URL`, network policy, and the Postgres `max_connections` budget (each QueueFlow process holds up to `--max-db-connections`, default 50). `/ready` returning non-200 while `/health` is 200 means the server is still starting (applying migrations, binding listeners).

## Still stuck

Run with `RUST_LOG=queueflow=debug,sqlx=warn` for per-job logging, read the row directly with the queries in [Inspecting with SQL](/internals#inspecting-with-sql), and open an issue on [queueflow-core](https://github.com/elision-labs/queueflow-core/issues) with the server version from `GET /health`, the log lines, and the job JSON.
