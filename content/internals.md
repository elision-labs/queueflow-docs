---
title: How it works
description: The schema, the claim query, lease tokens, LISTEN/NOTIFY, the janitor, how retries and schedules are rows, the workflow scheduler, and why the OpenAPI spec cannot drift.
---

This page explains the mechanisms behind the guarantees. Nothing here is needed to use QueueFlow, but it helps when you are deciding whether to trust it, sizing a database, or debugging with SQL.

## The schema

The migration creates a `queueflow` schema with four tables. Plain SQL, no extensions.

| Table | Role |
| --- | --- |
| `queueflow.jobs` | Every unit of work, and the claim queue. One row per job for its whole life. |
| `queueflow.workflows` | One row per workflow instance: name, status, accumulated `context`, `metadata`, tenant. |
| `queueflow.workflow_steps` | The DAG nodes: `(workflow_id, name)` primary key, `depends_on` as JSON, per-step config and policies, live `status`, and the `job_id` once scheduled. |
| `queueflow.dead_letters` | Terminal failures: `job_id`, `reason`, `error_message`, and replay bookkeeping. |

Key columns on `jobs`:

```sql
id               TEXT PRIMARY KEY,
queue_name       TEXT NOT NULL,
task_name        TEXT NOT NULL,
payload          JSONB NOT NULL DEFAULT '{}',
config           JSONB NOT NULL DEFAULT '{}',
status           TEXT NOT NULL DEFAULT 'pending',
priority         INTEGER NOT NULL DEFAULT 0,
scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when the row becomes claimable
locked_until     TIMESTAMPTZ,                           -- lease deadline while running
lease_token      UUID,                                  -- proof of ownership, new on every claim
delivery_count   INTEGER NOT NULL DEFAULT 0,
retry_count      INTEGER NOT NULL DEFAULT 0,
next_retry_at    TIMESTAMPTZ,
workflow_id      TEXT, workflow_step_id TEXT,
result           JSONB, error_message TEXT,
tenant_id        TEXT
```

The table is created `WITH (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05)`: claim, heartbeat, and finish all update the same row, so page headroom keeps those updates heap-only, and the low vacuum threshold keeps bloat in check.

Indexes that matter:

```sql
-- The hot dequeue path. Partial: terminal history never slows a claim.
CREATE INDEX idx_jobs_claim ON queueflow.jobs (queue_name, priority DESC, scheduled_at, created_at)
    WHERE status IN ('pending', 'retrying');

-- The janitor's expired-lease sweep.
CREATE INDEX idx_jobs_lease_expiry ON queueflow.jobs (locked_until) WHERE status = 'running';
```

plus ordinary indexes on `status`, `queue_name`, `created_at DESC`, `workflow_id`, `tenant_id`, and a GIN index on `metadata`.

## The jobs table is the queue

A job is on the queue when `status IN ('pending','retrying') AND scheduled_at <= now()`. Claiming is one statement, in spirit:

```sql
UPDATE queueflow.jobs
   SET status = 'running', locked_until = now() + $lease, lease_token = gen_random_uuid(),
       delivery_count = delivery_count + 1, started_at = coalesce(started_at, now())
 WHERE id IN (
       SELECT id FROM queueflow.jobs
        WHERE queue_name = $queue AND status IN ('pending','retrying') AND scheduled_at <= now()
        ORDER BY priority DESC, scheduled_at, created_at
        LIMIT $n
        FOR UPDATE SKIP LOCKED)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` lets any number of workers claim concurrently without blocking or double-claiming. Priority ordering falls straight out of the partial index.

## Leases and tokens

Owning a job means holding the row's current `lease_token` until `locked_until`. Every heartbeat, complete, and fail is an `UPDATE … WHERE id = $id AND lease_token = $token`. If zero rows match, the lease was lost and the API answers `409`. Tokens are regenerated on every claim, so a worker that went silent and comes back cannot act on a job that has since been reclaimed, retried, completed by someone else, or cancelled. This is the delivery-safety guarantee: no stale worker can overwrite a finished job.

## Delays are rows

A retry is not a timer. When an attempt fails with budget left, the engine computes the backoff, writes `status = 'retrying'`, `scheduled_at = next_retry_at`, and releases the row. The claim query naturally ignores it until then. The same mechanism implements `run_at` (a `pending` row with a future `scheduled_at`) and cron firings (a job inserted by the scheduler at the occurrence). Delays therefore survive restarts, are shared across every process, and are visible with `SELECT scheduled_at FROM queueflow.jobs WHERE id = …`.

## Waking workers: LISTEN/NOTIFY

An `AFTER INSERT` trigger on `jobs` runs `pg_notify('queueflow_work', NEW.queue_name)` for pending rows. Idle in-process workers and long-polling lease requests `LISTEN` on that channel and wake instantly when work arrives. Postgres deduplicates identical notifications within a transaction, so a batch insert of 1000 jobs on one queue is one wakeup. A 5 second safety poll covers the rare missed notification, so a pooler that drops `LISTEN` degrades to polling rather than stalling.

## The janitor

Every `worker`- and `all`-mode process runs a janitor loop (default every 5 seconds, 100 rows per sweep) that:

1. **Reclaims expired leases.** `running` jobs whose `locked_until` has passed are routed through the normal failure policy: retry if budget remains, otherwise dead-letter. They are briefly re-leased (60 seconds) while this happens so two janitors do not race.
2. **Self-heals workflows.** A workflow whose step completed but whose advancement did not run (a crash between the two writes) is advanced.
3. **Applies retention** (hourly, only when `--retention-hours` is set) by deleting terminal rows older than the window.

Because a crashed worker's job consumes a unit of retry budget on reclaim, a handler that always crashes ends up in the DLQ after `max_retries + 1` deliveries instead of looping forever.

## The workflow scheduler

A workflow is stored as a `workflows` row plus one `workflow_steps` row per step. On creation the DAG is validated (unique names, resolvable `depends_on`, no cycles) and every root step is enqueued. When a step's job completes:

1. Its result is merged into `workflows.context` under the step name.
2. Then the step is marked `completed`. The ordering matters: anyone who sees a dependency as `completed` is guaranteed to see its result in the context, so a fan-in step never runs with a partial `_context`.
3. Every step whose dependencies are all `completed` is claimed and enqueued in a single atomic store operation, keyed on the `(workflow_id, name)` primary key, so two workers finishing sibling steps concurrently cannot both schedule the join.
4. When nothing remains to schedule, the workflow's status is derived from its steps: all completed means `completed`; a `halt` failure means `failed` with the rest `cancelled`; any `skip` or `continue` failure means `partially_failed`.

Step jobs carry `workflow_id` and `workflow_step_id` and run on the default queue like any other job.

## Idempotent enqueue

An `Idempotency-Key` header is stored on the job, scoped to the tenant. A repeat create looks the key up and returns the original id. Cron uses the same mechanism internally with a per-firing key, which is what lets several schedulers coexist.

## Multi-tenancy

The authenticated tenant is attached to each request and becomes a `WHERE tenant_id = $tenant` on every tenant-facing read and write. Worker routes are the deliberate exception: a worker drains a queue regardless of tenant, which is why they take a separate credential.

## Ports and adapters

`queueflow-core` is written against a `JobStore` trait (storage plus claim queue) and a `Clock` trait. Two adapters ship: `PostgresJobStore` for production and `InMemoryJobStore` for tests and embedding. The whole engine, including the HTTP router and the Rust client, runs deterministically against the in-memory adapter with a `TestClock`, so durable-retry, timeout, dead-letter, idempotency, and workflow behaviour are all verified without a database. The Postgres adapter is then checked for parity by an opt-in integration suite.

## The spec cannot drift

The OpenAPI 3.1 document is generated from the handlers and types with `utoipa` annotations and emitted by `queueflow spec`. CI fails if the committed spec differs from the code. The SDKs' cores are generated from that spec, and the Rust client reuses the engine's types directly, so the server, the spec, the reference on this site, and every client describe the same contract.

## Inspecting with SQL

```sql
-- Queue depth per queue
SELECT queue_name, count(*) FROM queueflow.jobs
 WHERE status IN ('pending','retrying') AND scheduled_at <= now() GROUP BY 1;

-- Oldest claimable job (a latency signal)
SELECT now() - min(scheduled_at) FROM queueflow.jobs
 WHERE status IN ('pending','retrying') AND scheduled_at <= now();

-- Jobs that look like crashed workers
SELECT id, task_name, delivery_count, retry_count FROM queueflow.jobs
 WHERE delivery_count > retry_count + 1 ORDER BY created_at DESC LIMIT 20;

-- What a workflow is waiting on
SELECT name, status, job_id FROM queueflow.workflow_steps WHERE workflow_id = $1 ORDER BY idx;
```

Reads are safe at any time. Avoid writing to the tables directly; use the API so leases, policies, and workflow advancement stay consistent.
