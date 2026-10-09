---
title: Production deployment
description: Topologies, scaling, PostgreSQL sizing, health probes, metrics, logging, graceful shutdown, retention, and a security checklist for running QueueFlow in production.
---

QueueFlow is one stateless binary plus PostgreSQL. Everything durable is in the database, so any number of processes in any combination of modes can share it, and any of them can be restarted or replaced at will.

## Topologies

**Single process.** `queueflow serve --mode all` runs the API, in-process workers, janitor, and cron in one binary. Right for small deployments and for anything where handlers are remote workers anyway.

**Split API and workers.** Run `--mode api` replicas behind a load balancer for HTTP traffic, and `--mode worker` processes for in-process handlers, the janitor, and cron. Scale each independently. Remote workers in other languages connect to the API replicas like any other client.

```text
                 ┌──────────────┐    ┌──────────────┐
  apps / SDKs ──►│ api replica  │    │ api replica  │◄── remote workers (lease/heartbeat/complete)
                 └──────┬───────┘    └──────┬───────┘
                        └─────────┬─────────┘
                                  ▼
                            PostgreSQL 13+
                                  ▲
                 ┌────────────────┴───────────────┐
          ┌──────┴───────┐                 ┌──────┴───────┐
          │ worker proc  │                 │ worker proc  │   in-process handlers, janitor, cron
          └──────────────┘                 └──────────────┘
```

Rules that make this safe:

- Claims use `FOR UPDATE SKIP LOCKED`, so many processes draining one queue never double-claim.
- Cron firings carry per-firing idempotency keys, so many schedulers produce one job per occurrence.
- The janitor's sweeps are idempotent and lease-guarded, so many janitors do no harm.
- An `api`-only fleet needs at least one `worker`- or `all`-mode process for the janitor and cron to run.

## PostgreSQL

**Version and privileges.** Any plain PostgreSQL 13 or newer, no extensions. The role needs to create the `queueflow` schema (or you pre-create it) and tables within it.

**Connections.** Each process holds up to `--max-db-connections` (default 50). Budget `api replicas × pool + worker processes × pool` against `max_connections`, or put PgBouncer in transaction mode in front. Long-polling lease requests wait on `LISTEN/NOTIFY` and do not hold a connection while idle.

**The jobs table is update-heavy.** Claim, heartbeat, and finish all rewrite the same row. The migration sets `fillfactor = 85` so updates stay heap-only and skip index writes, and `autovacuum_vacuum_scale_factor = 0.05` so vacuum runs well before the default 20 percent dead tuples. Leave autovacuum on.

**Indexes.** The hot claim index is partial over `status IN ('pending','retrying')`, so completed history never slows claims. If you keep history forever the tables grow, but dequeue latency does not. See [How it works](/internals#the-schema).

**Managed Postgres.** RDS, Cloud SQL, Azure Database, Neon, Supabase, and Crunchy all work unmodified. `LISTEN/NOTIFY` is supported on all of them; if a pooler in front of the database strips it, workers fall back to a 5 second poll and keep working.

## Health and readiness

| Endpoint | 200 when | 503 when |
| --- | --- | --- |
| `GET /health` | The process is up and can reach the database. Body: `{"status":"ok","timestamp":…,"version":"0.2.0"}`. | The database is unreachable. |
| `GET /ready` | The server is ready to take traffic. | Not ready. |

Neither requires a token. Point liveness at `/health` and readiness at `/ready`.

```yaml
# Kubernetes container snippet
image: ghcr.io/elision-labs/queueflow:0.2
args: ["serve", "--mode", "api"]
env:
  - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: queueflow, key: database-url } } }
  - { name: QUEUEFLOW_API_KEYS, valueFrom: { secretKeyRef: { name: queueflow, key: api-keys } } }
  - { name: QUEUEFLOW_WORKER_TOKEN, valueFrom: { secretKeyRef: { name: queueflow, key: worker-token } } }
  - { name: QUEUEFLOW_CORS_ORIGINS, value: "https://app.example.com" }
  - { name: RUST_LOG, value: info }
ports:
  - { containerPort: 8000, name: http }
  - { containerPort: 9090, name: metrics }
livenessProbe:  { httpGet: { path: /health, port: http }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /ready,  port: http }, periodSeconds: 5 }
```

## Metrics

Prometheus metrics are served on `--metrics-port` (default 9090) at `/metrics`, with no authentication. Engine counters:

| Metric | Meaning |
| --- | --- |
| `queueflow_jobs_created_total` | Jobs enqueued by this process. |
| `queueflow_jobs_completed_total` | Jobs finished successfully by this process's workers. |
| `queueflow_jobs_failed_total` | Attempts that failed. |
| `queueflow_jobs_retried_total` | Retries scheduled. |
| `queueflow_jobs_dead_lettered_total` | Jobs that gave up. |
| `queueflow_workflows_created_total`, `queueflow_workflows_completed_total`, `queueflow_workflows_failed_total` | Workflow counterparts. |

Counters are per process. For fleet-wide or historical numbers, query the database: `SELECT status, count(*) FROM queueflow.jobs GROUP BY 1` and friends. `GET /api/v1/stats` is different in scope: it returns job and workflow counts for the calling tenant, so it is what an application shows its own users rather than an operator's view of the fleet.

Useful alerts: dead letters increasing (`rate(queueflow_jobs_dead_lettered_total[5m]) > 0`), the oldest claimable job's age (from SQL: `min(scheduled_at) WHERE status IN ('pending','retrying') AND scheduled_at <= now()`), and `/health` returning 503.

## Logging

Logs are structured JSON on stdout via `tracing`, filtered by `RUST_LOG` (for example `info`, or `queueflow=debug,sqlx=warn`). Every job attempt, retry, dead-letter, lease reclaim, and workflow transition is logged with its ids.

## Graceful shutdown

On `SIGINT` or `SIGTERM` the server stops accepting new claims, lets in-flight in-process handlers finish, and exits. Set your orchestrator's termination grace period to exceed your longest handler's expected duration. Remote workers are independent processes: a worker killed mid-job simply stops heartbeating, and the janitor reclaims the job within its lease plus one sweep interval (5 seconds), consuming one unit of retry budget.

## Retention

History is kept forever unless you set `--retention-hours`. With it, the janitor deletes terminal jobs, workflows, and dead letters older than the window once an hour. A week (`168`) is a common choice; pick a window at least as long as you want to be able to replay dead letters.

## Upgrades

Migrations are idempotent and run on startup by default, so a rolling restart onto a new image upgrades the schema safely. To separate schema changes from deploys, set `QUEUEFLOW_AUTO_MIGRATE=false` and run `queueflow migrate` as a release step. Within a minor version, API and worker processes of different patch versions can coexist against one database.

## Security checklist

- [ ] `--dev` not passed and `QUEUEFLOW_DEV` not set anywhere in the deployment. Without `--dev`, `api` and `all` mode refuse to start until the next two items are done.
- [ ] `--api-keys` and/or `--jwt-secret` set, so tenant auth is real.
- [ ] `--worker-token` set, and given only to worker processes.
- [ ] `--cors-origins` set if browsers call the API, otherwise irrelevant.
- [ ] TLS terminated in front of the API; the server speaks plain HTTP.
- [ ] Port 9090 (metrics) reachable only by your scraper.
- [ ] `DATABASE_URL` in a secret store, not in the image.
- [ ] Startup logs free of development-mode warnings (they only appear with `--dev`).

## Example: Docker Compose with a split topology

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: queueflow, POSTGRES_PASSWORD: queueflow, POSTGRES_DB: queueflow }
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U queueflow"], interval: 2s, timeout: 2s, retries: 30 }

  api:
    image: ghcr.io/elision-labs/queueflow:0.2
    command: serve --mode api --api-keys ${QUEUEFLOW_API_KEYS} --worker-token ${QUEUEFLOW_WORKER_TOKEN} --cors-origins https://app.example.com
    environment: { DATABASE_URL: postgres://queueflow:queueflow@postgres:5432/queueflow, RUST_LOG: info }
    ports: [ "8000:8000" ]
    depends_on: { postgres: { condition: service_healthy } }
    deploy: { replicas: 2 }

  worker:
    image: ghcr.io/elision-labs/queueflow:0.2
    # worker mode has no HTTP API, so it needs no credentials and no --dev.
    command: serve --mode worker --workers 20 --retention-hours 168
    environment: { DATABASE_URL: postgres://queueflow:queueflow@postgres:5432/queueflow, RUST_LOG: info }
    depends_on: { postgres: { condition: service_healthy } }

volumes:
  pgdata: {}
```

Remote workers in your own languages run as additional services that point at `http://api:8000` with the worker token.
