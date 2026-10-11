---
title: Comparison with other queues
description: How QueueFlow compares with River, Hatchet, Graphile Worker, pg-boss, and Temporal on storage, languages, workflows, dashboard, cron, dead letters, hosting, and license, and when to pick each of them instead.
---

These are the projects people most often weigh against QueueFlow. The table is about facts that are easy to get wrong; the paragraphs are about fit, including the cases where another tool is the better choice. Everything was checked against each project's current documentation on the date given under [Sources](#sources). Versions and features move, so re-check before deciding.

For hands-on migration from BullMQ, Celery, Sidekiq, or pg-boss, see the [migration guides](/migrate/bullmq).

## At a glance

| | QueueFlow 0.2 | River | Hatchet | Graphile Worker | pg-boss 12 | Temporal |
| --- | --- | --- | --- | --- | --- | --- |
| Storage | PostgreSQL 13+, no extensions | PostgreSQL (SQLite experimental) | PostgreSQL, optional RabbitMQ | PostgreSQL | PostgreSQL 13+ (also CockroachDB, Citus, PGlite) | Cassandra, MySQL, or PostgreSQL; SQLite for development; Elasticsearch recommended for visibility |
| Engine language | Rust | Go | Go | Node.js (TypeScript) | Node.js (TypeScript) | Go |
| Client languages | TypeScript, Python, Go, Rust (worker runtimes in TypeScript, Python, and the Rust `queueflow-client` crate; Go and the generated Rust SDK have none yet); HTTP for anything else | Go, Ruby, Rust, TypeScript; Python for inserting only | Python, TypeScript, Go, Ruby | Node.js; jobs can be inserted from SQL | Node.js; SQL for most operations from other runtimes | .NET, Go, Java, PHP, Python, Ruby, Rust, TypeScript |
| Workflows / DAGs | Yes: static DAG, `depends_on`, shared context, per-step `halt`/`skip`/`continue`; no conditional steps, sub-workflows, or fan-out yet | River Pro (paid): DAG workflows with dependency failure handling | Yes: DAGs with parent outputs, `skip_if` conditions, plus durable execution | No | Listed as "job dependency workflow orchestration" | Durable execution: workflows are code that is replayed, not declared DAGs |
| Dashboard | Not yet (in progress) | River UI (separate open-source project) | Yes | No | `@pg-boss/dashboard` | Web UI |
| Cron | Yes, UTC crontab, pause/resume, one firing per occurrence across servers | Periodic jobs held in memory by the elected leader; durable periodic jobs in River Pro | Yes, in code, by API, and in the dashboard | Yes, crontab file, UTC, optional backfill | Yes, cron and RRULE with time zones | Schedules with pause, backfill, and overlap policies |
| Dead letters | Yes, per tenant, inspect and replay once | River Pro | Not described; exhausted tasks are marked failed | No; exhausted jobs stay in the table | Yes, a named dead-letter queue per source queue, with redrive | No DLQ concept; retry policies and workflow failure |
| Hosting model | Separate server binary (or Docker image) plus Postgres; self-hosted | Library inside your Go application; self-hosted | Self-hosted (single image, Compose, Helm) or Hatchet Cloud | Library or CLI inside your Node process; self-hosted | Library inside your Node process; self-hosted | Self-hosted multi-service cluster, or Temporal Cloud |
| License | MIT | MPL-2.0 (River Pro is a paid subscription) | MIT | MIT | MIT | MIT |

Throughput is deliberately not a column. The only number QueueFlow publishes is its own: a drain rate that plateaus around 3,000 no-op jobs per second on one Postgres on a laptop, with batch enqueue at roughly 30,000 to 36,000 jobs per second (see [Benchmarks](/benchmarks)). Graphile Worker's site claims "up to 10,000 jobs per second". Neither figure was measured on the same hardware, and none of these numbers matter if your jobs do real work.

## River

River is a Go-first job queue on Postgres, with the queue running as a library inside your application and clients for Ruby, Rust, and TypeScript that insert and work jobs against the same tables. It is fast, well documented, and its unique-jobs feature (enforced with a partial unique index on `ByArgs`, `ByPeriod`, `ByQueue`, `ByState`) is more capable than QueueFlow's creation-time `Idempotency-Key`. River's retry policy defaults to 25 attempts with `attempts^4` backoff, which is a long tail compared with QueueFlow's default 3 retries.

Pick River over QueueFlow when your workers are Go and you want the queue embedded in the application process with no separate service to run, or when you need database-enforced uniqueness. Be aware that DAG workflows, a dead-letter queue, and durable periodic jobs are River Pro features sold as a paid subscription; the open-source periodic scheduler holds its schedule in memory on the leader. Pick QueueFlow when you want a language-neutral service with workflows, cron, and a dead-letter queue in the free product, multi-tenant isolation at the API, or workers in languages River does not cover.

## Hatchet

Hatchet is an orchestration engine for tasks, agents, and durable workflows, written in Go on Postgres (with optional RabbitMQ for high-throughput event delivery), with SDKs for Python, TypeScript, Go, and Ruby, a real-time dashboard, cron, rate limiting, concurrency policies, and conditional DAG execution (`skip_if`, `cancel_if`). It is available as Hatchet Cloud or self-hosted.

Pick Hatchet over QueueFlow when you need a dashboard today, conditional branching or durable execution inside workflows, rate limits and fair concurrency keys, or a managed cloud option. It covers more of the workflow space than QueueFlow does, and that gap is real. Pick QueueFlow when you want something smaller to operate (one binary and a database, no message broker, no cloud dependency), a REST API with a code-generated OpenAPI spec and clients you can regenerate yourself, or plain job-queue semantics with an explicit lease protocol you can implement in any language in an afternoon.

## Graphile Worker

Graphile Worker is a Node.js job runner on Postgres with a minimal surface: tasks are files in a `tasks/` folder, jobs are added with `addJob` or `graphile_worker.add_job(...)` from SQL, delivery uses `LISTEN/NOTIFY`, retries use `exp(least(10, attempt))` seconds of backoff up to `maxAttempts` (default 25), and a `crontab` file next to `tasks/` provides UTC schedules with optional backfill. `jobKey` with `jobKeyMode` lets you replace or deduplicate a pending job. There is no dashboard, no DLQ (exhausted jobs stay in the table until an admin function or cleanup handles them), and no workflow layer.

Pick Graphile Worker over QueueFlow when you are all-Node, want to enqueue from database triggers or SQL functions, and want the smallest possible footprint inside an existing Postgres-backed app. It is a very good fit for PostGraphile and PostgREST setups. Pick QueueFlow when workers are in several languages, when you need DAG workflows or a dead-letter queue, when jobs are created by callers you do not fully trust and tenant isolation matters, or when you prefer an HTTP boundary between the queue and the application.

## pg-boss

pg-boss is the closest architectural relative on this list: a Node.js library on Postgres 13+, claiming with `FOR UPDATE SKIP LOCKED`, with per-job retries and exponential backoff, deferred jobs, priorities, cron and RRULE schedules with time zones, named dead-letter queues with redrive, queue policies for throttling and singletons, transactional job creation through ORM adapters, OpenTelemetry, pub/sub, a dashboard package, and support for CockroachDB, Citus, and embedded PGlite.

Pick pg-boss over QueueFlow when you are all-Node and want to create jobs inside your own database transactions, when you need throttling or singleton queue policies, time-zone cron, or OpenTelemetry, or when you want a dashboard now. It is mature and well maintained. Pick QueueFlow when the queue should be a service shared by several languages, when you want DAG workflows with failure policies, when you want tenant isolation enforced by the queue rather than the application, or when you want the lease-token protocol's guarantee that a stalled worker cannot overwrite a job that has since been retried or completed elsewhere. The [pg-boss migration guide](/migrate/pg-boss) goes through the semantic differences.

## Temporal

Temporal is a durable-execution platform, not a job queue. Workflows are ordinary code in one of eight SDK languages; the Temporal Service records every event, and when a worker dies another one replays the history and continues from where execution stopped. It brings a Web UI, Schedules with backfill and overlap policies, retry policies enforced by the service, and a choice of Cassandra, MySQL, or PostgreSQL persistence with Elasticsearch recommended for visibility, self-hosted as a multi-service cluster or as Temporal Cloud.

Pick Temporal over QueueFlow when your workflows have branching, loops, timers measured in days, signals from outside, human-in-the-loop steps, or sagas with compensation, and when you can staff running (or pay for) the platform. A declared DAG of jobs is a poor fit for those shapes; durable execution is built for them. Pick QueueFlow when the problem is background jobs with retries and some fixed fan-in/fan-out pipelines, when the operational budget is one binary and the Postgres you already have, or when you want a plain REST API rather than an SDK-mediated programming model.

## Where QueueFlow sits

QueueFlow is a server, not a library, and that is the main axis of the comparison. Compared with the embedded Postgres queues (River, Graphile Worker, pg-boss) it costs you one more process to run and buys you language independence, tenant isolation, and an explicit lease protocol. Compared with the orchestration platforms (Hatchet, Temporal) it is far smaller to operate and far less expressive: static DAGs only, no conditional steps, no sub-workflows, no dynamic fan-out, no dashboard yet, no OpenTelemetry, no rate limits, and no webhooks. Those gaps are listed on the [roadmap](https://github.com/elision-labs/queueflow-core#roadmap) and in the [FAQ](/faq).

## Sources

All checked 2026-10-10.

River:

- <https://github.com/riverqueue/river> (Go, Postgres or SQLite, languages, MPL-2.0)
- <https://riverqueue.com/docs> (language integrations, River Pro section)
- <https://riverqueue.com/docs/job-retries> (25 attempts, `attempts^4` backoff)
- <https://riverqueue.com/docs/unique-jobs> (unique options, partial unique index)
- <https://riverqueue.com/docs/periodic-jobs> (in-memory leader schedule; durable periodic jobs in Pro)
- <https://riverqueue.com/docs/pro/workflows> and <https://riverqueue.com/pro> (Pro workflows, DLQ, subscription)
- <https://github.com/riverqueue/riverui> (River UI)

Hatchet:

- <https://github.com/hatchet-dev/hatchet> (Go, Postgres, SDKs, features, MIT)
- <https://docs.hatchet.run/home> (platform overview, cloud and self-hosted)
- <https://docs.hatchet.run/home/dags> (parents, `skip_if`)
- <https://docs.hatchet.run/home/cron-runs> (cron in code, API, dashboard)
- <https://docs.hatchet.run/home/retry-policies> (retries, backoff, failed state)
- <https://docs.hatchet.run/self-hosting> (Postgres, optional RabbitMQ, Lite, Compose, Helm)

Graphile Worker:

- <https://github.com/graphile/worker> (Node.js, MIT)
- <https://worker.graphile.org/> (LISTEN/NOTIFY, backoff, cron, performance claim)
- <https://worker.graphile.org/docs/library/add-job> (`maxAttempts` default 25, `jobKey`, `jobKeyMode`, `runAt`)
- <https://worker.graphile.org/docs/exponential-backoff> (`exp(least(10, attempt))`)
- <https://worker.graphile.org/docs/cron> (crontab file, UTC, backfill)
- <https://worker.graphile.org/docs/tasks> (task files, failure by throwing)
- <https://worker.graphile.org/docs/admin-functions> (permanently failed jobs remain until cleanup)

pg-boss:

- <https://github.com/timgit/pg-boss> (features, Postgres 13+, Node 22.12+, dashboard, MIT)
- <https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md> (policies, dead-letter queues)
- <https://github.com/timgit/pg-boss/blob/master/docs/api/scheduling.md> (cron, RRULE, `tz`)
- <https://github.com/timgit/pg-boss/blob/master/docs/database-backends.md> (CockroachDB, Citus, PGlite)

Temporal:

- <https://github.com/temporalio/temporal> (Go, MIT)
- <https://docs.temporal.io/evaluate/why-temporal> (durable execution, SDK languages, Web UI, Temporal Cloud)
- <https://docs.temporal.io/temporal-service/persistence> (Cassandra, MySQL, PostgreSQL, SQLite, Elasticsearch)
- <https://docs.temporal.io/schedule> (Schedules, pause, backfill, overlap policies)
