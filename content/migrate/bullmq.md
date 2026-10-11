---
title: Migrating from BullMQ
description: A concept map and side-by-side code for moving Node.js background jobs from BullMQ on Redis to QueueFlow on PostgreSQL, with the semantic differences that matter.
---

BullMQ is a Node.js job library backed by Redis (an optional PostgreSQL backend exists in BullMQ 6; see the note at the end). QueueFlow is a separate server process backed by PostgreSQL, talked to over HTTP. The programming model is close enough that most BullMQ code maps line for line onto the [TypeScript SDK](/sdks/typescript), but the execution model underneath is different, and that is where migrations go wrong. This page covers both.

Everything below uses `@queueflow/sdk` 0.2.1 against a 0.2.0 server. Only APIs that exist in the SDK are shown.

## Concept mapping

| BullMQ | QueueFlow | Notes |
| --- | --- | --- |
| `new Queue('emails')` | `queue: "emails"` on the job | Queues are implicit; enqueuing to a name creates it. There is no queue object to construct or close. |
| Job name (`queue.add('send', …)`) | `task` (`task_name` on the wire) | The handler key. |
| `data` | `payload` | Must be a JSON object. |
| `opts.attempts` | `maxRetries` | BullMQ counts total attempts; QueueFlow counts retries after the first attempt. `attempts: 3` is `maxRetries: 2`. |
| `opts.backoff: { type, delay }` (ms) | `retryBackoff`, `retryDelaySecs`, `retryMaxDelaySecs`, `jitterFactor` | Seconds, not milliseconds. QueueFlow adds `linear`, a delay cap, and jitter as first-class fields. |
| `opts.delay` (ms) | `runAt` (instant) | An absolute time rather than a relative delay. |
| `opts.priority` (1 is highest, 0 means none) | `priority` (higher is claimed first, default 0) | The direction is inverted. |
| `opts.jobId` | `idempotencyKey` | See [Idempotency](#idempotency-jobid-versus-idempotency-key). |
| `new Worker(queue, processor, { lockDuration })` | `qf.worker.run(queue, handlers, { leaseSecs })` | See [Locks versus leases](#locks-and-stalled-jobs-versus-leases-and-the-janitor). |
| `job.returnvalue` | `result` | The object the handler returns. |
| `UnrecoverableError` | `NonRetryableError` | Skip remaining retries and fail now. |
| The `failed` set | The dead-letter queue | See [Failed set versus DLQ](#the-failed-set-versus-the-dead-letter-queue). |
| `queue.upsertJobScheduler(id, { pattern })` | `qf.cron.create({ name, schedule, task })` | Both take crontab expressions. |
| Flows (`FlowProducer`, children before parent) | Workflows (`wf()`, `depends_on`) | Dependencies point the other way. |
| `QueueEvents` | `qf.jobs.watch(id)` (SSE) | Per job, not per queue. |
| `removeOnComplete` / `removeOnFail` | `--retention-hours` on the server | Retention is a server policy, not a per-job option. |
| Redis connection | `baseUrl` + `token` | Credentials are per tenant; see [Authentication and tenants](/concepts/auth). |

## Enqueue

```ts
// BullMQ
import { Queue } from "bullmq";
const emails = new Queue("emails", { connection });

await emails.add(
  "send-welcome",
  { to: "ada@example.com" },
  { attempts: 4, backoff: { type: "exponential", delay: 2000 }, priority: 5, jobId: "welcome-42" },
);
```

```ts
// QueueFlow
import { QueueFlow } from "@queueflow/sdk";
const qf = new QueueFlow({ baseUrl: "http://localhost:8000", token: process.env.QUEUEFLOW_TOKEN! });

await qf.jobs.create({
  task: "send-welcome",
  payload: { to: "ada@example.com" },
  queue: "emails",
  maxRetries: 3,                 // 4 attempts in total
  retryBackoff: "exponential",
  retryDelaySecs: 2,
  priority: 5,
  idempotencyKey: "welcome-42",
});
```

`qf.jobs.create` returns the full job record after a follow-up fetch; `qf.jobs.enqueue` returns only the id, which is closer to `queue.add` in cost. For bulk inserts, `qf.jobs.createBatch(inputs)` takes up to 1000 jobs per call and is the equivalent of `queue.addBulk`.

## Worker

```ts
// BullMQ
import { Worker } from "bullmq";

const worker = new Worker(
  "emails",
  async (job) => {
    if (job.name === "send-welcome") return await sendWelcome(job.data);
    throw new Error(`unknown job ${job.name}`);
  },
  { connection, concurrency: 1, lockDuration: 30000 },
);
```

```ts
// QueueFlow
await qf.worker.run(
  "emails",
  {
    "send-welcome": async (job, ctx) => {
      // ctx.signal aborts if the job is cancelled or the lease is lost.
      return await sendWelcome(job.payload, { signal: ctx.signal });
    },
  },
  { leaseSecs: 30, waitSecs: 20 },
);
```

Differences to notice:

- Handlers are keyed by task name in the handlers map, so the `switch` on `job.name` disappears. A leased job with no matching handler is failed as non-retryable and dead-lettered rather than left to block the queue.
- `qf.worker.run` takes a `concurrency` option (default 1) that plays the role of BullMQ's `concurrency`: up to that many handlers run at once, and each lease asks for as many jobs as there are free slots. Pass a `signal` to stop; the runtime drains in-flight handlers for `drainTimeoutMs` before resolving.
- The worker needs the server's **worker token**, passed as `workerToken` in the client options. A tenant token on the worker routes is a `403`, and `run()` throws on `401`/`403` instead of retrying. See [Authentication and tenants](/concepts/auth#the-worker-credential).
- Throwing anything fails the attempt as retryable. Throw `NonRetryableError` (or any error with `retryable: false`) where you would have thrown `UnrecoverableError`.

## Retries and backoff

BullMQ's `exponential` backoff waits `2 ^ (attempts - 1) * delay` milliseconds with optional `jitter`; without `backoff`, retries are immediate. QueueFlow's `exponential` is `retry_delay_secs * 2^n` for retry `n`, capped at `retry_max_delay_secs` (default one hour) and jittered by `jitter_factor` (default 0.1). The default base delay is 60 seconds, so a job created without any retry fields does not retry immediately. Set `retryDelaySecs: 1` and `jitterFactor: 0` if you want behaviour closer to BullMQ's defaults.

```ts
// BullMQ: 3 attempts, 1s, 2s between them
{ attempts: 3, backoff: { type: "exponential", delay: 1000 } }

// QueueFlow: 3 attempts (1 + 2 retries), ~1s, ~2s between them
{ maxRetries: 2, retryBackoff: "exponential", retryDelaySecs: 1, retryMaxDelaySecs: 60, jitterFactor: 0 }
```

Custom `backoffStrategy` functions have no equivalent. QueueFlow offers `fixed`, `linear`, and `exponential`, each with the cap and jitter. See [Retries, timeouts and the DLQ](/concepts/retries#backoff).

## Scheduled and recurring jobs

```ts
// BullMQ: run once in five minutes
await emails.add("send-digest", { user: 7 }, { delay: 5 * 60 * 1000 });

// QueueFlow
await qf.jobs.create({ task: "send-digest", payload: { user: 7 }, queue: "emails", runAt: new Date(Date.now() + 5 * 60 * 1000) });
```

A QueueFlow job with a future `runAt` is a row whose `scheduled_at` is in the future. It is invisible to workers until then and survives restarts because nothing about it lives in memory.

```ts
// BullMQ: a Job Scheduler
await emails.upsertJobScheduler("nightly-digest", { pattern: "0 2 * * *", tz: "UTC" }, { name: "send-digest", data: { all: true } });

// QueueFlow
const schedule = await qf.cron.create({ name: "nightly-digest", schedule: "0 2 * * *", task: "send-digest", payload: { all: true }, queue: "emails" });
await qf.cron.pause(schedule.id);
await qf.cron.resume(schedule.id);
```

Differences:

- QueueFlow cron expressions are always UTC; there is no `tz` option. Convert local schedules.
- BullMQ produces the next job only when the previous one begins processing, so a backlog slows the schedule. QueueFlow enqueues exactly one job per occurrence regardless of backlog, collapses a long outage into a single catch-up firing, and does not catch up occurrences missed while paused. See [Cron schedules](/concepts/cron#firing-semantics).
- Schedules are listed, paused, resumed, and deleted through `qf.cron`; there is no `every`-style interval, so express intervals as crontab (`*/5 * * * *`).

## Flows versus workflows

A BullMQ flow runs children first and moves the parent to `waiting` once every child has finished; the parent reads child results with `getChildrenValues()`. A QueueFlow workflow is declared the other way round, as steps with `depends_on`, and each step reads its upstream results from `_context` in its payload.

```ts
// BullMQ
const flow = await new FlowProducer({ connection }).add({
  name: "assemble-report",
  queueName: "reports",
  children: [
    { name: "fetch-sales", data: {}, queueName: "reports" },
    { name: "fetch-costs", data: {}, queueName: "reports" },
  ],
});
```

```ts
// QueueFlow
import { wf } from "@queueflow/sdk";

const run = await qf.workflows.create(
  wf("monthly-report")
    .step("fetch-sales", "fetch-sales")
    .step("fetch-costs", "fetch-costs")
    .step("assemble", "assemble-report", { after: ["fetch-sales", "fetch-costs"], onFailure: "halt" }),
);
const finished = await qf.workflows.waitFor(run.id);
```

Two things do not carry over:

- Workflow steps always run on the server's default queue (`--default-queue`), not on a queue of your choosing per step. Put a worker on that queue.
- Flows can be built dynamically with an arbitrary number of children. QueueFlow workflows are static DAGs: no dynamic fan-out, no sub-workflows, and no conditional steps yet. A step can emulate fan-out by enqueuing ordinary jobs from its handler. See [Workflows](/concepts/workflows#current-limits).

## Semantic differences that matter

### At-least-once, in both systems

Both BullMQ and QueueFlow deliver at least once. A BullMQ job whose worker dies is detected as stalled and re-queued; a QueueFlow job whose worker dies has its lease reclaimed and is retried. In both cases the handler can run twice, so handlers must be idempotent. Nothing changes in your mental model here, only in the mechanism.

### Locks and stalled jobs versus leases and the janitor

BullMQ places a lock on an active job for `lockDuration` (default 30000 ms) and renews it on `lockRenewTime` (half of that by default). If the Node event loop is blocked and the lock is not renewed, the job is flagged as stalled on the next `stalledInterval` check (default 30000 ms). A stalled job goes back to `waiting`, and once it has stalled `maxStalledCount` times (default 1) it moves to `failed`.

QueueFlow leases a job to a worker for `leaseSecs` (default 30) and hands back a `lease_token`. The SDK heartbeats at half the lease interval while the handler runs. Every heartbeat, complete, and fail call must present the token; if the janitor (which sweeps every 5 seconds) has reclaimed the job because the lease expired, the token is stale and the server answers `409`. The reclaimed job is routed through the normal retry policy, consuming one unit of retry budget each time, so a handler that always crashes ends in the DLQ after `maxRetries + 1` deliveries instead of looping.

The practical differences:

- A stale BullMQ worker that wakes up after a stall can still call `moveToCompleted` on a job someone else is now processing. In QueueFlow the stale token makes that write a `409`; a worker that was presumed dead cannot overwrite a job that has since been retried, completed elsewhere, or cancelled.
- In BullMQ a stall is distinct from a failure and has its own counter. In QueueFlow a lease expiry is a retryable failure, visible as `delivery_count > retry_count + 1` on the job.
- Long handlers in QueueFlow do not need a long lease; the heartbeat extends it for as long as the work takes, up to 3600 seconds per extension.

### The failed set versus the dead-letter queue

In BullMQ a job that exhausts its attempts (or throws `UnrecoverableError`) lands in the queue's `failed` set, where it stays until `removeOnFail` or manual cleanup removes it, and can be retried in place with `job.retry()`.

In QueueFlow the job becomes `failed` and gets an entry in the dead-letter queue with a `reason` (`max_attempts_exceeded`, `non_retryable`, or `handler_not_found`). `qf.dlq.list()` and `qf.dlq.get(id)` inspect entries; `qf.dlq.replay(id)` creates a **fresh job** with the same task, payload, queue, and config and a full retry budget. Each entry replays at most once (a second replay is a `ConflictError`), and a replayed workflow step does not advance its workflow. See [The dead-letter queue](/concepts/retries#the-dead-letter-queue).

### Idempotency: `jobId` versus `Idempotency-Key`

BullMQ's `jobId` deduplicates within a queue: adding a job whose id already exists is ignored, but once the earlier job has been removed (manually or by `removeOnComplete`) the id can be reused. QueueFlow's `idempotencyKey` is sent as an `Idempotency-Key` header, scoped to the tenant: a repeat create with the same key returns the **original job id** with a `201` rather than being ignored, and it keeps working for as long as the original job row exists (forever unless `--retention-hours` is set). Keys can contain `:`.

If you relied on `jobId` to make a job's id predictable so you could fetch it later, keep your own mapping instead: QueueFlow assigns ids.

### Timeouts

BullMQ has no per-job timeout; a stall is the only time bound. QueueFlow's `timeout` (default 300 seconds) bounds in-process Rust handlers only. Remote handlers, including every `qf.worker.run` handler, are bounded by the lease and heartbeat instead. If you need to abort your own long-running work, do it in the handler and honour `ctx.signal`.

### Priority direction

BullMQ: `priority: 1` is the highest, larger numbers are lower, and `0` means unprioritized (processed before prioritized jobs). QueueFlow: higher `priority` is claimed first, default `0`, and ties break on `scheduled_at` then `created_at`. Invert your numbers.

### Events

`QueueEvents` publishes queue-wide events over Redis streams. QueueFlow offers a per-job Server-Sent Events stream (`GET /api/v1/jobs/{id}/events`, wrapped as `qf.jobs.watch(id)`) that closes at a terminal state, plus `qf.jobs.waitFor(id)` polling. There is no queue-wide event feed; use `qf.jobs.list({ status, queue })` or Prometheus metrics for aggregate views.

### What BullMQ has that QueueFlow does not

- Per-queue rate limiting. QueueFlow has none yet; rate limits are on the roadmap.
- Sandboxed processors in child processes.
- Dynamic flows of arbitrary size.
- A large ecosystem of dashboards (Bull Board, Taskforce.sh). QueueFlow has no web dashboard yet (in progress); use the CLI, the API, or SQL.
- Multi-language ports (Python, and bindings for Rust, Elixir, PHP, .NET). QueueFlow's answer is the HTTP worker protocol and SDKs for TypeScript, Python, Go, and Rust, each with a worker runtime.

### BullMQ on PostgreSQL

BullMQ 6 ships an optional PostgreSQL backend (`createPostgresBackend`, PostgreSQL 13 or newer) that implements the same API as the Redis backend and also claims jobs with `FOR UPDATE SKIP LOCKED`. If your only reason to move is "we want to drop Redis", evaluate that first: it keeps your code unchanged. Choose QueueFlow when you also want the queue to be a language-neutral service with DAG workflows, multi-tenant isolation, a REST API and generated clients, and workers in languages other than Node.

## Checklist

1. Start a server with real credentials (`--api-keys`, `--worker-token`); see [Installation](/installation).
2. Replace `queue.add` with `qf.jobs.create` or `qf.jobs.enqueue`, converting `attempts` to `maxRetries`, milliseconds to seconds, `delay` to `runAt`, and inverting `priority`.
3. Replace each `Worker` with a `qf.worker.run` call keyed by task name, with `workerToken` configured. Replace `UnrecoverableError` with `NonRetryableError`.
4. Recreate Job Schedulers as cron schedules in UTC.
5. Rebuild flows as `wf()` DAGs with `after`, and put a worker on the default queue.
6. Decide on `--retention-hours` instead of `removeOnComplete` / `removeOnFail`.
7. Make handlers idempotent if they were not already; both systems can deliver twice.

## Sources

BullMQ documentation, checked 2026-10-10:

- <https://docs.bullmq.io/> (index: Redis backing store, features, MIT license)
- <https://docs.bullmq.io/guide/retrying-failing-jobs> (`attempts`, `backoff`, custom strategies)
- <https://docs.bullmq.io/patterns/stop-retrying-jobs> (`UnrecoverableError`)
- <https://docs.bullmq.io/guide/workers> and <https://docs.bullmq.io/guide/workers/stalled-jobs> (locks, stalled jobs)
- <https://docs.bullmq.io/api/interfaces/v5.WorkerOptions.html> (`lockDuration`, `stalledInterval`, `maxStalledCount` defaults)
- <https://docs.bullmq.io/guide/jobs/job-ids> (`jobId` deduplication)
- <https://docs.bullmq.io/guide/jobs/delayed> (`delay`)
- <https://docs.bullmq.io/guide/jobs/prioritized> (priority direction)
- <https://docs.bullmq.io/guide/job-schedulers> (`upsertJobScheduler`)
- <https://docs.bullmq.io/guide/flows> (`FlowProducer`)
- <https://docs.bullmq.io/guide/postgresql> (PostgreSQL backend)
