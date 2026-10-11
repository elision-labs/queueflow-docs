---
title: FAQ
description: Short answers on deployment, PostgreSQL requirements, worker crashes, exactly-once expectations, multi-tenancy, running locally without credentials, scaling, and licensing.
---

## Deployment

### What do I need to run QueueFlow?

One `queueflow` binary (or the `ghcr.io/elision-labs/queueflow:0.2` image) and a PostgreSQL database. There is no Redis, no broker, and no separate state store. The binary runs the REST API, the in-process workers, the janitor, and the cron scheduler, together (`--mode all`) or split (`--mode api`, `--mode worker`). See [Installation](/installation) and [Production deployment](/deployment).

### Can I run more than one server?

Yes, any number, in any mix of modes, against one database. Claims are serialized by `FOR UPDATE SKIP LOCKED`, cron firings are deduplicated by per-firing idempotency keys, and the janitor's sweeps are idempotent, so adding processes never double-runs anything. An `api`-only fleet still needs at least one `worker`- or `all`-mode process somewhere for the janitor and cron to run. See [Topologies](/deployment#topologies).

### Does it run on Kubernetes, Docker Compose, Railway, a VM?

Anywhere a container or static binary runs and can reach Postgres. The [deployment page](/deployment) has a Kubernetes container snippet and a Compose file. `demo.queueflow.dev` runs the Docker image on Railway. There is no Helm chart yet; it is on the roadmap.

### Is there a hosted or managed version?

No. QueueFlow is self-hosted. The [comparison page](/compare) lists alternatives with a cloud offering if you need one.

### Is there a web dashboard?

Not yet; it is in progress. Today the observability surface is the REST API (`GET /api/v1/jobs`, `/workflows`, `/dlq`, `/stats`), the [`queueflow` CLI](/cli), Server-Sent Events per job, Prometheus metrics on port 9090, structured JSON logs, and SQL against the `queueflow` schema (see [Inspecting with SQL](/internals#inspecting-with-sql)).

## PostgreSQL

### Which PostgreSQL versions and flavours work?

Any plain PostgreSQL 13 or newer. No extensions are required or used. RDS, Aurora PostgreSQL, Cloud SQL, Azure Database, Neon, Supabase, Crunchy, and a local container all work unmodified.

### What privileges does the database role need?

Enough to create a schema named `queueflow` and tables, indexes, and triggers inside it (or have them pre-created with `queueflow migrate` by a more privileged role, with `QUEUEFLOW_AUTO_MIGRATE=false` on the servers). At runtime it reads and writes those tables and uses `LISTEN`/`NOTIFY`.

### Does it work behind PgBouncer or another pooler?

Yes. In transaction-pooling mode `LISTEN` is not available, so workers and long-polling lease requests fall back to the bounded 5 second poll instead of waking instantly; the server logs a warning and keeps retrying the listener in the background. Throughput is unaffected; only wake-up latency on an idle queue changes. Session pooling keeps `LISTEN/NOTIFY` working. See [Troubleshooting](/troubleshooting#workers-wake-up-slowly-behind-pgbouncer).

### How big does the database get?

History is kept forever by default. Terminal rows never slow the claim path, because the hot index is partial over `pending` and `retrying` jobs, but the tables grow. Set `--retention-hours` (for example `168` for a week) to have the janitor delete terminal jobs, workflows, and dead letters older than the window once an hour. See [Retention](/configuration#retention).

### Can I share the database with my application?

Yes. Everything lives in the `queueflow` schema. Read the tables freely; write through the API so leases, policies, and workflow advancement stay consistent.

## Delivery guarantees

### What happens when a worker crashes mid-job?

The job stays `running` with a lease deadline (`locked_until`). When the deadline passes without a heartbeat, the janitor, which sweeps every 5 seconds, reclaims the job and routes it through the normal failure policy: a retry is scheduled if budget remains, otherwise the job is dead-lettered with reason `max_attempts_exceeded`. The reclaim consumes one unit of retry budget, so a handler that always crashes ends in the dead-letter queue after `max_retries + 1` deliveries instead of looping forever. On the job, `delivery_count` greater than `retry_count + 1` is the signature of this path. See [Leases and tokens](/internals#leases-and-tokens).

A crashed worker that comes back later cannot do damage: its `lease_token` is stale, and the server answers `409` to any heartbeat, complete, or fail it sends.

### Is delivery exactly-once?

No. Delivery is at-least-once. A worker can finish the work and die before reporting, or the `complete` call can fail on the network, and the job will be delivered again. What QueueFlow does guarantee is that **outcomes** are written at most once per lease: a stale worker cannot overwrite a job that has since been retried, completed elsewhere, or cancelled, and completing an already-finished job is an idempotent `204`. Make handlers idempotent by keying side effects on the job id or a natural key in the payload. See [Designing handlers for at-least-once delivery](/concepts/retries#designing-handlers-for-at-least-once-delivery).

### Can the same job run on two workers at once?

Not through the claim path: `FOR UPDATE SKIP LOCKED` hands each row to exactly one claimer. It can happen if a worker stops heartbeating long enough for its lease to expire and then keeps working while another worker picks the job up. Heartbeat at half the lease interval (the SDK runtimes do this) and stop when a heartbeat says the job is no longer `running`.

### Are retries durable?

Yes. A retry is a row with `status = 'retrying'` and a future `scheduled_at`; nothing about it lives in a process's memory. Restart every server and the retry still fires on time. The same applies to `run_at` and cron firings. See [Delays are rows](/internals#delays-are-rows).

### Is enqueue idempotent?

If you send an `Idempotency-Key` header (or `idempotencyKey` / `idempotency_key` in the SDKs). A repeat create with the same key, from the same tenant, returns the original job id with a `201`. Keys live as long as the original job row. Batch creates do not take keys.

## Multi-tenancy and security

### How does multi-tenancy work?

Every tenant-facing request carries a bearer token that resolves to a tenant id: a static API key (`--api-keys "token:tenant,…"`) or an HS256 JWT whose `sub` is the tenant (`--jwt-secret`). Every job, workflow, cron schedule, and dead letter stores that `tenant_id`, and every read and write is scoped to it; another tenant's job is a `403`. Idempotency keys and cron names are unique per tenant. Worker routes are the deliberate exception: a worker drains a queue regardless of tenant, which is why they take a separate credential. See [Authentication and tenants](/concepts/auth).

### Are queues per tenant?

No. Queue names are global; a worker leasing from `emails` sees every tenant's `emails` jobs. If tenants must not share workers, give them differently named queues and separate worker deployments.

### Why are there two kinds of token?

Because they grant different things. A tenant token lets an application create and read its own work. The worker token lets a process execute anyone's work and see every payload. Mixing them up is a `403`; keeping them in different secret stores is the point.

### How do I run it locally without setting up credentials?

Pass `--dev` (or set `QUEUEFLOW_DEV=1`):

```bash
queueflow serve --dev
```

Any non-empty bearer token then authenticates as the fixed tenant `tenant1`, the worker routes accept any authenticated caller, and the server warns about both at startup. Without `--dev`, `serve` in `api` or `all` mode refuses to start until `--api-keys` and/or `--jwt-secret` **and** `--worker-token` are configured; it fails closed rather than running open. Never run a `--dev` server on a network you do not control. See [Development mode](/concepts/auth#development-mode).

### Is there TLS?

Not in the server; it speaks plain HTTP. Terminate TLS in front of it with a load balancer, ingress, or reverse proxy, and set `--cors-origins` if browsers call the API directly.

## Scaling and performance

### How fast is it?

On a laptop with Postgres in Docker and default durability, batch enqueue runs at roughly 30,000 to 36,000 jobs per second, sequential single enqueue at about 140 jobs per second (a latency probe, roughly 7 ms per round trip), and the drain rate for no-op jobs plateaus around 3,000 jobs per second from 4 workers upward. Every number, the harness, and the caveats are on [Benchmarks](/benchmarks).

### Why does throughput plateau at a few thousand jobs per second?

Each no-op job costs about two Postgres round trips (a claim transaction and a completion transaction), and past a few workers the shared write path of a single Postgres is the limit. Adding workers beyond that adds claim contention rather than throughput. This is the price of every state transition being a durable transactional write; there is no faster mode that trades away crash safety.

### How many workers should I run?

Size workers to your handlers, not to the benchmark. If a job takes 500 ms of real work, 32 workers sustain about 64 jobs per second and the engine's roughly 1 ms of overhead is noise. The plateau only matters when jobs are near-instant; if you have sustained thousands of near-instant jobs per second, batch them into fewer, larger jobs.

### How should I scale the database connections?

Each QueueFlow process holds up to `--max-db-connections` (default 50). Budget `api replicas × pool + worker processes × pool` against Postgres `max_connections`, or put PgBouncer in front. Long-polling lease requests do not hold a connection while they wait. See [PostgreSQL](/deployment#postgresql).

### Can one worker serve several queues?

A remote worker leases from one queue per `run` call in every SDK runtime. Run one worker loop (thread, task, process, or container) per queue; each loop can run several handlers at once with its `concurrency` option.

### Is there rate limiting or per-tenant quotas?

Not yet; both are on the roadmap, along with OpenTelemetry export and webhooks.

## Workflows

### What can workflows express?

A static directed acyclic graph of steps with `depends_on` edges, a shared context threaded through `_context`, and per-step `halt`, `skip`, or `continue` failure policies. Cycles are rejected at creation. See [Workflows](/concepts/workflows).

### What can they not express yet?

Conditional steps (a predicate evaluated before scheduling), sub-workflows, and dynamic fan-out. A step can emulate fan-out by enqueuing ordinary jobs from its handler. Steps always run on the server's default queue.

## Project

### What is the license?

MIT, for the server, every crate, and every SDK.

### Which versions go together?

Server and CLI 0.3.0, `queueflow-core` and `queueflow-client` 0.3.0, `@queueflow/sdk` 0.3.0, PyPI `queueflow` 0.3.0, Go SDK `v0.3.0`, and the generated Rust `queueflow-sdk` 0.3.0. Within a minor version, API and worker processes of different patch versions can share a database. See the [version table](/#components-and-versions) and the [changelog](/changelog).

### Where do I report a problem?

[GitHub issues on queueflow-core](https://github.com/elision-labs/queueflow-core/issues). For a security issue, follow `SECURITY.md` in that repository.
