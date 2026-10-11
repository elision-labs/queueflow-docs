---
title: Migrating from pg-boss
description: A concept map and side-by-side code for moving Node.js jobs from the pg-boss library to the QueueFlow server, both on PostgreSQL, with the semantic differences that matter.
---

pg-boss and QueueFlow both keep the queue in PostgreSQL and both claim jobs with `FOR UPDATE SKIP LOCKED`, so the storage story is the same. The difference is architectural: pg-boss is a library that runs inside your Node process and talks to Postgres directly; QueueFlow is a separate server that your code talks to over HTTP, with handlers either compiled into the server (Rust) or running as remote workers in any language. Most pg-boss calls map onto the [TypeScript SDK](/sdks/typescript) one to one.

Everything below uses pg-boss 12, `@queueflow/sdk` 0.2.1, and a 0.2.0 server. Only APIs that exist in the SDK are shown.

## Concept mapping

| pg-boss | QueueFlow | Notes |
| --- | --- | --- |
| `new PgBoss(connectionString)` + `boss.start()` | `new QueueFlow({ baseUrl, token })` | The client holds no database connection; the server does. |
| `boss.createQueue(name, options)` | Nothing | Queues are implicit. Queue-level defaults do not exist; policy is per job. |
| Queue name | `queue` | A string on the job. |
| `boss.send(name, data, options)` | `qf.jobs.create({ task, payload, queue, … })` | pg-boss has no task name separate from the queue; QueueFlow has both. |
| `data` | `payload` | JSON object. |
| `retryLimit` (default 2) | `maxRetries` (default 3) | Both count retries after the first attempt. |
| `retryDelay` (default 0), `retryBackoff` (default false), `retryDelayMax` | `retryDelaySecs` (default 60), `retryBackoff` (default `exponential`), `retryMaxDelaySecs`, `jitterFactor` | Seconds in both. |
| `startAfter` | `runAt` | pg-boss accepts seconds, an interval string, or a `Date`; QueueFlow takes an instant. |
| `priority` (higher first) | `priority` (higher first) | Same direction. |
| `expireInSeconds` (default 15 minutes) | `leaseSecs` + heartbeat (remote); `timeout` (in-process) | See [Expiration versus lease](#expiration-versus-lease-and-heartbeat). |
| `singletonKey`, `singletonSeconds`, `sendDebounced` | `idempotencyKey` | Different semantics; see [Idempotency](#idempotency-singletonkey-versus-idempotency-key). |
| `id` option on `send` | Not available | QueueFlow assigns ids. |
| `boss.work(name, options, handler)` with `([job])` | `qf.worker.run(queue, { task: handler })` | One job at a time in both by default. |
| Handler return value (`output`) | `result` | |
| `boss.fail(name, id, err)` / throwing | Throwing, or `NonRetryableError` | |
| `deadLetter` queue on `createQueue` | The dead-letter queue | See [Dead letter queue](#dead-letter-queues). |
| `boss.schedule(name, cron, data, { tz })` | `qf.cron.create({ name, schedule, task, payload, queue })` | QueueFlow is UTC only; no RRULE. |
| `boss.cancel` / `boss.resume` / `boss.retry` | `qf.jobs.cancel(id)`; `qf.dlq.replay(id)` | No resume; a cancelled job stays cancelled. |
| `retentionSeconds`, `deleteAfterSeconds` | `--retention-hours` on the server | Server-wide, applies to terminal rows. |
| `@pg-boss/dashboard` | No dashboard yet (in progress) | |
| Postgres 13+, also CockroachDB, Citus, PGlite | Plain Postgres 13+ | QueueFlow is tested only on stock PostgreSQL. |

## Enqueue

```js
// pg-boss
const { PgBoss } = require('pg-boss');
const boss = new PgBoss('postgres://user:pass@host/db');
await boss.start();
await boss.createQueue('email-send', { retryLimit: 3, retryDelay: 2, retryBackoff: true });

const id = await boss.send('email-send', { to: 'ada@example.com' }, { priority: 5, singletonKey: 'welcome-42' });
```

```ts
// QueueFlow
import { QueueFlow } from "@queueflow/sdk";
const qf = new QueueFlow({ baseUrl: "http://localhost:8000", token: process.env.QUEUEFLOW_TOKEN! });

const job = await qf.jobs.create({
  task: "send-email",
  payload: { to: "ada@example.com" },
  queue: "emails",
  maxRetries: 3,
  retryBackoff: "exponential",
  retryDelaySecs: 2,
  priority: 5,
  idempotencyKey: "welcome-42",
});
```

Two shape differences: QueueFlow jobs have a `task` as well as a `queue`, so one queue can carry several kinds of work and the worker dispatches by task name; and there is no queue to create or configure first, so retry settings that lived on `createQueue` move onto each job (or onto the code that enqueues it).

`qf.jobs.enqueue` returns only the id, like `boss.send`. `qf.jobs.createBatch(inputs)` takes up to 1000 jobs per call.

## Worker

```js
// pg-boss
await boss.work('email-send', { pollingIntervalSeconds: 2 }, async ([job]) => {
  await sendEmail(job.data);
  return { sent: true };
});
```

```ts
// QueueFlow
await qf.worker.run(
  "emails",
  {
    "send-email": async (job, ctx) => {
      await sendEmail(job.payload, { signal: ctx.signal });
      return { sent: true };
    },
  },
  { leaseSecs: 30, waitSecs: 20 },
);
```

Differences to notice:

- pg-boss polls every `pollingIntervalSeconds` with optional LISTEN/NOTIFY delivery. QueueFlow's lease call long-polls for `waitSecs` and the server wakes it from `LISTEN/NOTIFY`, so an idle worker holds an HTTP request rather than issuing queries.
- The handler is keyed by task name. A leased job with no matching handler is failed as non-retryable and dead-lettered.
- The worker needs the server's **worker token** (`workerToken` in the client options); a tenant token on worker routes is a `403`, and `run()` throws on `401`/`403` rather than spinning. pg-boss has no equivalent because the library connects to the database directly. See [Authentication and tenants](/concepts/auth#the-worker-credential).
- `batchSize` has no runtime equivalent; `qf.worker.run` leases one job at a time. The lower-level `qf.worker.lease(queue, { maxJobs })` can lease a batch if you heartbeat every job in it yourself.
- Both systems treat a thrown error as a retryable failure. Throw `NonRetryableError` to dead-letter immediately; pg-boss has no direct counterpart short of setting `retryLimit: 0`.

## Retries and backoff

pg-boss retries `retryLimit` times (default 2) after `retryDelay` seconds (default 0), with `retryBackoff: true` switching to exponential growth from `retryDelay`, capped by `retryDelayMax`. QueueFlow defaults to 3 retries with exponential backoff from 60 seconds, capped at 3600, with 10 percent jitter, and also offers `fixed` and `linear`.

```js
// pg-boss: 5 retries, exponential from 10s
await boss.send('report', data, { retryLimit: 5, retryDelay: 10, retryBackoff: true, retryDelayMax: 600 });
```

```ts
// QueueFlow
await qf.jobs.create({ task: "report", payload, maxRetries: 5, retryBackoff: "exponential", retryDelaySecs: 10, retryMaxDelaySecs: 600 });
```

In both systems a retry is a row scheduled in the future, so backoff survives restarts. The `scheduled_at` and `next_retry_at` columns show when the next attempt becomes claimable. See [Retries, timeouts and the DLQ](/concepts/retries#backoff).

## Scheduled and recurring jobs

```js
// pg-boss
await boss.send('email-reminder', { userId: 123 }, { startAfter: 300 });          // seconds
await boss.sendAfter('email-reminder', { userId: 123 }, null, 300);               // same thing
```

```ts
// QueueFlow
await qf.jobs.create({ task: "email-reminder", payload: { userId: 123 }, runAt: new Date(Date.now() + 300_000) });
```

```js
// pg-boss
await boss.schedule('nightly-report', '0 3 * * *', { format: 'pdf' }, { tz: 'America/Chicago' });
await boss.unschedule('nightly-report');
```

```ts
// QueueFlow
const schedule = await qf.cron.create({ name: "nightly-report", schedule: "0 9 * * *", task: "build-report", payload: { format: "pdf" }, queue: "reports" });
await qf.cron.pause(schedule.id);
await qf.cron.resume(schedule.id);
await qf.cron.delete(schedule.id);
```

Differences:

- QueueFlow cron is UTC only and has no RRULE support; `0 3 * * *` in Chicago becomes `0 8 * * *` or `0 9 * * *` depending on daylight saving, so pick one or move the schedule.
- QueueFlow schedules have `pause` and `resume`; pg-boss has `schedule` and `unschedule`.
- pg-boss checks schedules every 30 seconds and files a job under the minute it falls in. QueueFlow enqueues exactly one job per occurrence across any number of server processes, deduplicated by per-firing idempotency keys, and collapses a long outage into a single catch-up firing. See [Cron schedules](/concepts/cron#firing-semantics).

## Semantic differences that matter

### Library versus server

With pg-boss every process that enqueues or works jobs holds Postgres connections and runs pg-boss's maintenance (expiration, archiving, cron) itself. With QueueFlow only the server talks to Postgres; producers and remote workers talk HTTP. That means:

- Connection budgeting is per QueueFlow process (`--max-db-connections`, default 50), not per application instance.
- Job creation cannot share your application's database transaction. pg-boss's "send inside an ORM transaction" pattern has no equivalent; use `idempotencyKey` so a retried create after a rolled-back transaction is harmless, and write the job after the commit.
- Workers can be written in Python, Go, Rust, or anything that speaks HTTP, against one queue.
- Multi-tenancy is built in: every job, workflow, schedule, and dead letter carries a `tenant_id` derived from the caller's credential.

### Expiration versus lease and heartbeat

pg-boss bounds an active job with `expireInSeconds` (default 15 minutes); a handler that runs past it has its `signal` aborted and the job is failed and retried per the queue's policy. QueueFlow bounds a remote job with a **lease** (`leaseSecs`, default 30) that the SDK extends by heartbeating at half the interval for as long as the handler runs. There is no upper bound on handler duration; the lease is proof of liveness, not a time limit. If the worker dies, the janitor (sweeping every 5 seconds) reclaims the job once the lease expires and routes it through the retry policy, consuming one unit of retry budget.

Every heartbeat, complete, and fail call carries a `lease_token` that is regenerated on each claim. A worker that stalled and comes back presents a stale token and gets a `409`, so it cannot overwrite a job that has since been retried or completed elsewhere. pg-boss 12 has a heartbeat too, and its docs note that a job can be failed after its heartbeat went stale "and may already be running elsewhere"; the lease token is QueueFlow's answer to that race.

`timeout` (default 300 seconds) exists in QueueFlow but applies only to in-process Rust handlers.

### At-least-once in both

Both systems can run a handler twice: pg-boss after an expiration, QueueFlow after a lease expiry or a lost network call on `complete`. Handlers should already be idempotent; nothing changes here.

### Dead letter queues

pg-boss copies a job that exhausts its retries into the queue named by `deadLetter` on `createQueue`, where it becomes an ordinary job on that queue with its own retry and expiration settings and `sourceName`/`sourceId` fields pointing back; `redrive` moves it back. QueueFlow has one dead-letter queue per tenant rather than one per source queue. A failed job gets an entry with a `reason` (`max_attempts_exceeded`, `non_retryable`, `handler_not_found`) and the last `error_message`; the original job row stays in place as `failed`. `qf.dlq.list()` and `qf.dlq.get(id)` inspect entries, and `qf.dlq.replay(id)` creates a fresh job with the same task, payload, queue, and config and a full retry budget. Each entry replays at most once (a second replay is a `ConflictError`). Dead letters are not jobs and are not worked by anyone. See [The dead-letter queue](/concepts/retries#the-dead-letter-queue).

### Idempotency: `singletonKey` versus `Idempotency-Key`

pg-boss's `singletonKey` and `singletonSeconds` throttle: within a time slot (or while a matching job is queued, depending on the queue policy) a second `send` resolves `null` and nothing is created, and `sendDebounced` pushes the job to the next slot instead. The `id` option lets you choose a job's id.

QueueFlow's `idempotencyKey` is sent as an `Idempotency-Key` header, scoped to the tenant, and makes **creation** idempotent: a second create with the same key returns the original job id with a `201`, for as long as the original row exists (forever unless `--retention-hours` is set). It does not throttle, and it does not apply to batch creates. There is no singleton or debounce policy and no way to choose an id; if you used `singletonKey` to prevent concurrent runs of the same job, you will need to enforce that in the handler.

### Queue policies and partitions

pg-boss queue policies (`short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo`) and per-queue partitioning have no equivalent. QueueFlow queues are plain names; ordering within a queue is `priority DESC, scheduled_at, created_at`, and concurrency is however many workers you run. Rate limits and quotas are on the roadmap.

### Retention

pg-boss keeps completed jobs for `deleteAfterSeconds` (default 7 days) and queued jobs for `retentionSeconds` (default 14 days). QueueFlow keeps everything forever unless `--retention-hours` is set, in which case the janitor deletes terminal jobs, workflows, and dead letters older than the window once an hour. Completed history never slows claims because the claim index is partial over `pending` and `retrying`.

### Workflows

pg-boss 12 lists "job dependency workflow orchestration" among its features; QueueFlow's [workflows](/concepts/workflows) are static DAGs with `depends_on`, per-step `halt`/`skip`/`continue` policies, a shared context, and a Mermaid diagram endpoint, with no conditional steps, sub-workflows, or dynamic fan-out yet. Compare the two directly if workflows are why you are moving.

### What pg-boss has that QueueFlow does not

- In-process operation with no extra service to deploy.
- Transactional job creation through ORM adapters (Drizzle, Knex, Kysely, Prisma).
- Queue policies, throttling, and debouncing.
- A dashboard (`@pg-boss/dashboard`), OpenTelemetry traces and metrics, and pub/sub fan-out.
- Time-zone-aware cron and RRULE schedules.
- CockroachDB, Citus, and embedded PGlite backends.

## Checklist

1. Start a server with real credentials (`--api-keys`, `--worker-token`); see [Installation](/installation).
2. Replace `boss.send` with `qf.jobs.create` or `qf.jobs.enqueue`, moving queue-level retry defaults onto each job and `startAfter` to `runAt`.
3. Replace `boss.work` with `qf.worker.run` keyed by task name, with `workerToken` configured.
4. Replace `singletonKey` used for request deduplication with `idempotencyKey`; handle singleton or debounce semantics in the handler.
5. Recreate `boss.schedule` entries as cron schedules in UTC.
6. Decide on `--retention-hours` instead of `deleteAfterSeconds` / `retentionSeconds`.
7. Point your dead-letter triage at `qf.dlq` instead of a per-queue DLQ worker.

## Sources

pg-boss documentation, checked 2026-10-10:

- <https://github.com/timgit/pg-boss> (README: requirements, feature list, quickstart, dashboard, MIT license)
- <https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md> (`send` options and defaults, `fail`, `complete`, `cancel`, `resume`, `retry`)
- <https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md> (`createQueue`, policies, `deadLetter`)
- <https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md> (`work`, `pollingIntervalSeconds`, `batchSize`, heartbeat and expiration)
- <https://github.com/timgit/pg-boss/blob/master/docs/api/scheduling.md> (`schedule`, `tz`, check intervals)
- <https://github.com/timgit/pg-boss/blob/master/docs/database-backends.md> (Postgres, CockroachDB, Citus, PGlite)
