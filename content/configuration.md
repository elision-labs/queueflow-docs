---
title: Configuration
description: Every flag and environment variable accepted by queueflow serve, plus how to choose a mode, configure authentication, CORS, the database pool, and retention.
---

Every option of `queueflow serve` is available as a command-line flag and as an environment variable. Flags take precedence. Run `queueflow serve --help` for the same list from the binary.

## Server options

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--mode` | `QUEUEFLOW_MODE` | `all` | `api` (REST API only), `worker` (in-process workers, janitor, and cron only), or `all`. |
| `--database-url` | `DATABASE_URL` | required | PostgreSQL connection string, for example `postgres://user:pass@host:5432/db`. |
| `--api-port` | `QUEUEFLOW_API_PORT` | `8000` | Port for the REST API, Swagger UI, and probes. |
| `--metrics-port` | `QUEUEFLOW_METRICS_PORT` | `9090` | Port for the Prometheus `/metrics` endpoint. |
| `--workers` | `QUEUEFLOW_WORKERS` | `10` | Number of concurrent in-process workers on the default queue. |
| `--default-queue` | `QUEUEFLOW_DEFAULT_QUEUE` | `default` | Queue used when a job, cron schedule, or workflow step does not name one. Workflow steps always run here. |
| `--worker-token` | `QUEUEFLOW_WORKER_TOKEN` | unset | Credential required by the worker-protocol endpoints (lease, heartbeat, complete, fail). Unset means development mode: any authenticated caller may lease work, with a startup warning. |
| `--jwt-secret` | `QUEUEFLOW_JWT_SECRET` | unset | HS256 secret for tenant JWTs on `/api/v1`. The `sub` claim is the tenant id; `exp` is enforced. May be combined with `--api-keys`. |
| `--api-keys` | `QUEUEFLOW_API_KEYS` | unset | Static tenant API keys as comma-separated `token:tenant` pairs, for example `k1:acme,k2:globex`. With neither this nor `--jwt-secret`, any non-empty token maps to one fixed tenant. |
| `--cors-origins` | `QUEUEFLOW_CORS_ORIGINS` | unset | Comma-separated list of origins allowed by CORS. Unset means permissive CORS (development mode). |
| `--max-db-connections` | `QUEUEFLOW_MAX_DB_CONNECTIONS` | `50` | Upper bound on the connection pool. |
| `--auto-migrate` | `QUEUEFLOW_AUTO_MIGRATE` | `true` | Apply embedded migrations on startup. Set the environment variable to `false` to manage migrations with `queueflow migrate` instead. |
| `--retention-hours` | `QUEUEFLOW_RETENTION_HOURS` | unset | Delete terminal jobs, workflows, and dead letters older than this many hours. Unset keeps history forever. |

Logging uses `tracing` with JSON output and an `env-filter`, so `RUST_LOG=info` or `RUST_LOG=queueflow=debug,sqlx=warn` controls verbosity.

## Choosing a mode

- **`all`** is the right default for a single process: API, in-process workers, janitor, and cron in one binary.
- **`api`** runs only the HTTP layer. Use it when every handler is a [remote worker](/concepts/workers) in another language, or to scale the API independently. Note that an `api`-only deployment still needs at least one `worker`-mode process somewhere for the janitor (lease recovery, retention) and cron firings to run.
- **`worker`** runs in-process Rust handlers, the janitor, and the cron scheduler with no HTTP listener other than metrics.

Any number of processes in any mode can share one database. Claims are serialized by `FOR UPDATE SKIP LOCKED`, cron firings are deduplicated by per-firing idempotency keys, and the janitor's sweeps are safe to run concurrently.

## Authentication

Three independent credentials exist. Configure all of them in production.

| Credential | Flag | Who uses it |
| --- | --- | --- |
| Tenant API key | `--api-keys` | Applications enqueuing and reading jobs, workflows, cron, and the DLQ. Each key maps to one tenant. |
| Tenant JWT | `--jwt-secret` | Same routes, but with HS256-signed tokens whose `sub` is the tenant id. Lets you mint short-lived tenant tokens without restarting the server. |
| Worker token | `--worker-token` | Processes that lease and report work. Workers see every tenant's payloads, so this must never be a tenant token. |

With none of them set the server runs in development mode and says so at startup. See [Authentication and tenants](/concepts/auth) for details and examples.

## CORS

Browsers can call the API directly, for example to stream job events into a dashboard. Restrict the origins in production:

```bash
queueflow serve --cors-origins "https://app.example.com,https://admin.example.com"
```

Unset means any origin is allowed, which is intended for local development only.

## Database pool

The default pool of 50 connections is enough for the API plus ten in-process workers. The API uses a connection per in-flight request; each in-process worker holds one while it claims, heartbeats, or finishes a job; the janitor and cron scheduler use a few more. Long-polling lease requests do not hold a connection while they wait for a `NOTIFY`. Size the pool against your Postgres `max_connections` across every QueueFlow process you run.

## Retention

History is kept forever by default. Terminal rows never slow the claim path, because the hot index only covers `pending` and `retrying` jobs, but they do grow the tables. Enable a retention window to let the janitor delete terminal jobs, workflows, and dead letters older than the limit, once an hour:

```bash
queueflow serve --retention-hours 168   # keep one week
```

Dead letters whose original job has been removed by retention can still be listed, but can no longer be replayed (`404`).

## Job-level configuration

Retry counts, backoff, timeouts, and priority are set per job, per workflow step, or per cron schedule rather than server-wide. Omitted fields take the engine defaults: 3 retries, a 60 second base delay, exponential backoff capped at one hour with 10 percent jitter, a 5 minute timeout, and priority 0. See [Jobs](/concepts/jobs#job-configuration).

## Client configuration

The `queueflow` binary doubles as a CLI client. It reads `QUEUEFLOW_SERVER_URL` (default `http://localhost:8000`) and `QUEUEFLOW_TOKEN` (default `dev`), or the equivalent `--server-url` and `--token` flags. See [CLI](/cli).
