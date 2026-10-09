---
title: Introduction
description: QueueFlow is a PostgreSQL-native distributed job queue and workflow engine written in Rust. Durable background jobs and DAG workflows on the database you already run.
---

QueueFlow runs durable background jobs and real DAG workflows directly on PostgreSQL. Any plain PostgreSQL 13 or newer works, with no extensions: RDS, Cloud SQL, Azure, or the Postgres on your laptop. There is no Redis, no broker, and no separate state store. The jobs table is the queue.

Workers claim rows with `FOR UPDATE SKIP LOCKED` and own them through lease tokens. A retry, a scheduled job, and a cron firing are all just rows whose `scheduled_at` lies in the future, so delays survive restarts. Handlers can be compiled into the server in Rust, or run in any language over an HTTP worker protocol with the same retry, dead-letter, and workflow semantics.

<div class="cards">
<a href="/quickstart"><strong>Quick start</strong><span>Run the engine against Postgres, enqueue a job, and drain it with a worker in a few minutes.</span></a>
<a href="/concepts/workflows"><strong>Workflows</strong><span>Declare a DAG of steps with dependencies, context propagation, and per-step failure policies.</span></a>
<a href="/concepts/workers"><strong>Remote workers</strong><span>The lease, heartbeat, complete, and fail protocol that lets handlers run in any language.</span></a>
<a href="/api"><strong>REST API reference</strong><span>Every endpoint and schema, generated from the OpenAPI document the server itself emits.</span></a>
</div>

## What you get

- **Durable jobs** with priority, per-job retry policies, timeouts, future scheduling with `run_at`, and idempotent creation through an `Idempotency-Key` header.
- **Workflows as DAGs.** Declare steps and `depends_on` edges. The engine gates each step on its dependencies, threads results through a shared context, applies `halt`, `skip`, or `continue` failure policies, and rejects cycles at creation.
- **Durable retries** with fixed, linear, or exponential backoff, a delay cap, and jitter. Retries are rows scheduled in the future, not timers in memory.
- **A dead-letter queue** for exhausted, non-retryable, and unhandled jobs, with an API to inspect and replay them.
- **Cron schedules** from standard crontab expressions in UTC, deduplicated across servers, with pause and resume.
- **Polyglot workers.** A lease token protocol over HTTP, with first-party clients for TypeScript, Python, Go, and Rust.
- **Multi-tenancy.** Tenant isolation on every job, workflow, cron, and dead-letter endpoint, with API keys or HS256 JWTs.
- **Observability.** Prometheus metrics, structured JSON logs, health and readiness probes, and a Server-Sent Events stream of job status changes.
- **A code-generated OpenAPI 3.1 spec.** The document is derived from the handlers and ships with every release, so clients never drift from the server.

## How it fits together

```text
                 ┌───────────────────────────────────────────────┐
  your app ──►   │  queueflow serve                              │
  (SDK / curl)   │   REST API :8000   ·   metrics :9090          │
                 │   in-process workers (optional, Rust)         │
                 │   scheduler · janitor · cron                  │
                 └──────────────────────┬────────────────────────┘
                                        │ SQL (FOR UPDATE SKIP LOCKED, LISTEN/NOTIFY)
                                        ▼
                              PostgreSQL 13+  (queueflow.jobs is the queue)
                                        ▲
                                        │ HTTP lease / heartbeat / complete / fail
  remote workers ───────────────────────┘
  (TypeScript, Python, Go, Rust, anything)
```

One binary, `queueflow`, runs the API, the in-process workers, or both (`--mode api|worker|all`). It applies its own migrations on startup. Clients talk to the REST API; remote workers lease jobs from the same API. Everything durable lives in Postgres.

## Components and versions

| Component | Where | Version |
| --- | --- | --- |
| Server and CLI (`queueflow`) | [crates.io](https://crates.io/crates/queueflow), [GitHub releases](https://github.com/elision-labs/queueflow-core/releases), `ghcr.io/elision-labs/queueflow` | 0.2.0 |
| Engine as a library (`queueflow-core`) | [crates.io](https://crates.io/crates/queueflow-core) | 0.2.0 |
| Rust client and worker runtime (`queueflow-client`) | [crates.io](https://crates.io/crates/queueflow-client) | 0.2.0 |
| TypeScript SDK (`@queueflow/sdk`) | [npm](https://www.npmjs.com/package/@queueflow/sdk) | 0.2.0 |
| Python SDK (`queueflow`) | [PyPI](https://pypi.org/project/queueflow/) | 0.2.1 |
| Go SDK | [GitHub](https://github.com/elision-labs/queueflow-sdk-go) | 0.2.0 (`v0.2.0`) |
| Rust generated SDK (`queueflow-sdk`) | [crates.io](https://crates.io/crates/queueflow-sdk) | 0.2.0 |

QueueFlow is MIT licensed. Source for everything is under the [elision-labs](https://github.com/elision-labs) GitHub organization.

## Where to go next

- New to QueueFlow: follow the [quick start](/quickstart), then read [Jobs](/concepts/jobs) and [Workflows](/concepts/workflows).
- Writing a worker in your language: read [Remote workers](/concepts/workers) and your [SDK page](/sdks/typescript).
- Putting it in production: read [Configuration](/configuration), [Authentication and tenants](/concepts/auth), and [Production deployment](/deployment).
- Curious how it works: read [How it works](/internals).
