---
title: TypeScript SDK
description: The @queueflow/sdk package for Node.js and TypeScript. A typed client with resource groups, waiters, an SSE watcher, a workflow builder, a concurrent worker runtime with graceful stop, and typed errors.
---

`@queueflow/sdk` is a hand-written facade over a core generated from the server's OpenAPI spec. The wire types and transport are regenerated and never drift; the facade adds the ergonomics codegen cannot express. It has zero runtime dependencies, uses the built-in `fetch`, and ships dual ESM and CommonJS builds with its own type declarations.

- **Requires** Node.js 18 or newer.
- **Source**: [elision-labs/queueflow-sdk-nodejs](https://github.com/elision-labs/queueflow-sdk-nodejs). **Package**: [npm](https://www.npmjs.com/package/@queueflow/sdk), version 0.4.0.

## Install

```bash
npm install @queueflow/sdk@0.4.0
```

## Quick start

```ts
import { QueueFlow, wf } from "@queueflow/sdk";

const qf = new QueueFlow({
  baseUrl: "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN ?? "dev",
});

// Enqueue a job and wait for the result.
const job = await qf.jobs.create({ task: "echo", payload: { hello: "world" }, maxRetries: 3, timeout: 30 });
const done = await qf.jobs.waitFor(job.id);
console.log(done.status, done.result);

// Declare and run a DAG workflow.
const workflow = await qf.workflows.create(
  wf("etl")
    .step("extract", "echo")
    .step("transform", "echo", { after: ["extract"] })
    .step("load", "echo", { after: ["transform"], onFailure: "halt" }),
);
const finished = await qf.workflows.waitFor(workflow.id);
console.log(finished.status, finished.context);
```

`echo` is a handler built into the server; it returns the payload plus `"echoed": true`.

## Client options

```ts
const qf = new QueueFlow({
  baseUrl,       // required
  token,         // required; tenant API key or JWT
  workerToken,   // credential for qf.worker routes (defaults to token, which only works against a --dev server)
  timeoutMs,     // per-request timeout, default 30_000
  maxRetries,    // retries for idempotent calls on network errors and 502/503/504, default 2
  fetch,         // inject a custom fetch (tests, proxies)
});

await qf.health();   // GET /health
await qf.ready();    // GET /ready
```

Idempotent calls (reads, leases, and creates that carry an idempotency key) are retried on transport failures and gateway errors; non-idempotent calls are not. The lease long-poll gets its own per-call timeout of `waitSecs + 35` seconds.

## Jobs: `qf.jobs`

| Method | Description |
| --- | --- |
| `create(input)` | Enqueue, then fetch and return the full `Job`. |
| `enqueue(input)` | Enqueue and return only the new job id. |
| `createBatch(inputs)` | Enqueue up to 1000 jobs; returns `{ job_ids, count }`. |
| `get(id)` | Fetch a job. |
| `list(opts?)` | List jobs. |
| `cancel(id)` | Cancel a job. |
| `waitFor(id, opts?)` | Poll until `completed`, `failed`, or `cancelled`. |
| `watch(id, opts?)` | Async-iterate status changes over SSE; ends at a terminal state. |

`input` is camelCase and maps onto the request body and config:

```ts
interface CreateJobInput {
  task: string;
  payload?: JsonObject;
  queue?: string;                // override the destination queue
  priority?: number;             // higher is dequeued first
  maxRetries?: number;           // attempts before dead-lettering
  timeout?: number;              // per-attempt timeout, seconds
  retryBackoff?: "fixed" | "linear" | "exponential";
  retryDelaySecs?: number;       // base retry delay
  retryMaxDelaySecs?: number;    // cap on any computed delay
  jitterFactor?: number;         // 0..=1, 0.1 = +/-10%
  idempotencyKey?: string;       // sent as the Idempotency-Key header
  runAt?: Date | string;         // don't run before this instant
}
```

Unset fields are not sent, so the server defaults apply. The same `idempotencyKey` returns the original job instead of creating a duplicate.

`list` options: `status`, `queue`, `limit`, `offset`, `orderBy` (`"created_at ASC" | "created_at DESC"`), `includeTotal`, `cursor`, `createdAfter`, `createdBefore`. Responses carry `next_cursor` when there is another page; pass it back as `cursor` for keyset pagination, which is cheaper than deep `offset`.

`waitFor` options: `timeoutMs` (default 60_000, throws `TimeoutError`), `intervalMs` (default 500), `signal` (throws `AbortError`).

```ts
for await (const snapshot of qf.jobs.watch(job.id)) {
  console.log(snapshot.status);   // running, then completed
}
```

## Workflows: `qf.workflows`

| Method | Description |
| --- | --- |
| `create(builderOrBody)` | Create from a `wf()` builder or a raw `CreateWorkflowRequest`; returns the full `Workflow`. |
| `get(id)` · `list(opts?)` · `cancel(id)` | Fetch, list, cancel. |
| `steps(id)` | Live step states: `{ name, status, job_id }[]` in declaration order. |
| `diagram(id)` | `{ format: "mermaid", diagram }`. |
| `waitFor(id, opts?)` | Poll until `completed`, `failed`, `partially_failed`, or `cancelled`. |

### The `wf()` builder

```ts
import { wf } from "@queueflow/sdk";

const dag = wf("order_123")
  .step("validate", "validate_order", { payload: { order_id: 123 } })
  .step("pay", "process_payment", { after: ["validate"], config: { max_retries: 4, retry_delay_secs: 2 } })
  .step("ship", "create_shipment", { after: ["pay"], onFailure: "continue" })
  .context({ source: "web" })
  .metadata({ app: "shop" });

dag.build(); // runs locally: duplicate names, dangling deps, and cycles throw WorkflowValidationError
```

`step(name, task, options?)` takes a `StepOptions` object:

| Option | Meaning |
| --- | --- |
| `after` | Names of steps that must complete before this one runs. |
| `payload` | JSON object passed to the task handler. |
| `config` | Per-step `JobConfig` override in wire-format snake_case (`max_retries`, `timeout`, `priority`, and so on). |
| `onFailure` | `"halt"` (default), `"skip"`, or `"continue"`. |
| `onSuccess` | The step's success policy. |
| `metadata` | Free-form JSON attached to the step. |

`context()` and `metadata()` seed the workflow-level fields and merge across calls. `qf.workflows.create` calls `build()` for you.

## Worker: `qf.worker`

`run()` is a complete remote worker: it leases jobs from one queue, dispatches each to a handler by task name, heartbeats while handlers run, and reports the outcome. The engine owns retries, backoff, the dead-letter queue, and workflow advancement, so a TypeScript handler gets the same semantics as one compiled into the server.

```ts
import { QueueFlow, NonRetryableError } from "@queueflow/sdk";

const qf = new QueueFlow({
  baseUrl: "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN!,               // tenant token
  workerToken: process.env.QUEUEFLOW_WORKER_TOKEN!,  // the server's --worker-token
});

// Aborting the signal stops the worker: the in-flight long poll is cancelled
// at once and running handlers get drainTimeoutMs to finish and report.
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

const { unfinished } = await qf.worker.run(
  "orders",
  {
    "send-email": async (job) => {
      if (!job.payload?.to) {
        throw new NonRetryableError("no recipient");   // dead-letters immediately
      }
      await sendEmail(job.payload);                     // any other throw retries per policy
      return { sent: true };
    },
    transcode: async (job, ctx) => {
      // ctx.signal aborts if the job is cancelled mid-run, the lease is lost,
      // or the drain gives up on this handler while stopping.
      for (const chunk of chunks(job.payload)) {
        if (ctx.signal.aborted) return {};              // the server owns the outcome now
        await process(chunk, { signal: ctx.signal });
      }
      return { ok: true };
    },
  },
  { concurrency: 4, signal: controller.signal, drainTimeoutMs: 30_000 },
);

for (const job of unfinished) {
  console.warn("abandoned", job.id);  // still running when the drain gave up; the server redelivers
}
```

### Signature

```ts
qf.worker.run(
  queue: string,
  handlers: Record<string, WorkerHandler>,
  options?: WorkerRunOptions,
): Promise<WorkerRunResult>

type WorkerHandler = (job: Job, ctx: WorkerContext) => Promise<JsonObject>;
interface WorkerContext { signal: AbortSignal }
interface WorkerRunResult { unfinished: Job[] }
```

### Options

All optional:

| Option | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `1` | Handlers running at once. Each lease asks for as many jobs as there are free slots (capped at the server's 100 per call); no lease is issued while every slot is busy. |
| `leaseSecs` | `30` | Lease duration per job. Every in-flight job is heartbeated at half this interval. |
| `waitSecs` | `20` | Long-poll wait when the queue is empty. |
| `signal` | none | Stop signal. Aborting it cancels the in-flight long poll immediately, then drains. Without it the loop runs forever. |
| `drainTimeoutMs` | `30000` | How long to wait for in-flight handlers after `signal` aborts. |
| `onError` | throttled `console.warn` | Called on transient lease errors (network, 5xx). The default logs the first failure and every 30th consecutive one. |

### Handler contract

- A handler is called as `handler(job, ctx)`. `job` is the leased `Job` (`job.id`, `job.task_name`, `job.payload`, `job.config`, and so on); `ctx.signal` is an `AbortSignal`.
- Return a JSON object to store as the job's `result`. For a workflow step the result is merged into the workflow context.
- Throwing anything fails the attempt as **retryable**: the engine schedules a retry if budget remains, otherwise dead-letters the job with reason `max_attempts_exceeded`.
- Throwing `NonRetryableError`, or any error whose `retryable` property is `false`, fails the attempt as **non-retryable**: the job is dead-lettered immediately with reason `non_retryable`. Use it for bad input and other permanent errors.
- A leased job whose task name has no handler is failed non-retryably (`no remote handler for task '...'`), so it does not block the queue.
- Delivery is at-least-once. Key side effects on `job.id` or a natural key in the payload.

### Heartbeats and cancellation

Each in-flight job is heartbeated every `leaseSecs / 2` seconds, extending the lease by `leaseSecs`, for as long as the handler runs. If a heartbeat reports that the job is no longer `running` (it was cancelled mid-run, or the lease expired and was reclaimed) or answers `409`, the server owns the outcome: the runtime aborts `ctx.signal`, stops heartbeating, and reports nothing, whatever the handler then returns or throws. Handlers that loop over work should check `ctx.signal` and stop.

If reporting an outcome fails (the server is unreachable, for example), the runtime logs a warning and does not retry the report. The lease expires and the engine redelivers the job; a reporting error is never converted into a job failure.

### Stop and drain

Aborting `signal` cancels the in-flight long poll immediately, so stopping never waits out `waitSecs`. Handlers already running get up to `drainTimeoutMs` to finish and report. Any handler still running after that has its `ctx.signal` aborted and is left unreported: its lease expires and the server redelivers the job. `run()` resolves once the drain is over, with `unfinished` listing those abandoned jobs (empty when everything finished in time).

### Lease errors

A `401` or `403` from the lease call is thrown rather than retried, after the same drain, because a wrong or missing `workerToken` cannot heal by retrying. Any other lease error (a `5xx`, a network failure) goes to `onError`, or to the default throttled `console.warn`, and the loop sleeps one second before trying again.

### The raw protocol

The lower-level calls are also exposed on `qf.worker`, authenticated with `workerToken`: `lease(queue, { maxJobs, leaseSecs, waitSecs, signal })`, `heartbeat(lease, extendSecs)`, `complete(lease, result)`, `fail(lease, error, { retryable })`. A hand-rolled loop must honour the same contract as `run()`; see [Remote workers](/concepts/workers).

## Cron: `qf.cron`

| Method | Description |
| --- | --- |
| `create({ name, schedule, task, payload?, queue? })` | Register a recurring enqueue (5-field crontab, UTC); returns the `CronSchedule`. |
| `get(id)` · `list(opts?)` · `delete(id)` | Fetch, list, delete. |
| `pause(id)` · `resume(id)` | Stop firings, or resume at the next future occurrence. |

## Dead letters: `qf.dlq`

| Method | Description |
| --- | --- |
| `list(opts?)` · `get(id)` | Inspect terminally failed jobs. Ids are numbers. |
| `replay(id)` | Re-run one as a fresh job; returns the new job id. A second replay is a `ConflictError`. |

## System: `qf.system`

```ts
await qf.system.stats();   // job and workflow counters for this tenant
await qf.system.tasks();   // names of handlers registered in the server
await qf.system.queues();  // live per-queue backlog
```

`queues()` (`GET /api/v1/queues`) returns a `QueueStats[]` with one entry per queue that currently has non-terminal jobs: the claimable `pending` count, the future-dated `scheduled` count, the `running` count, and how long the oldest claimable job has waited. Use it to decide whether to add workers. Queues with nothing pending, scheduled, or running are omitted.

## Errors

All errors extend `QueueFlowError`:

```ts
import { NotFoundError, ApiError } from "@queueflow/sdk";

try {
  await qf.jobs.get("missing");
} catch (err) {
  if (err instanceof NotFoundError) { /* 404 */ }
  else if (err instanceof ApiError) { console.error(err.status, err.body); }
  else throw err;
}
```

| Class | When |
| --- | --- |
| `BadRequestError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409) | HTTP errors, all subclasses of `ApiError`. |
| `ConnectionError` | Network failures or a per-request timeout in transport. |
| `TimeoutError` | A `waitFor` ran out of time. |
| `AbortError` | A `waitFor`, or a lease long poll, was aborted by its signal. |
| `WorkflowValidationError` | A `wf()` builder failed local validation. |
| `NonRetryableError` | Throw this from a worker handler to dead-letter the job immediately. |

## Types

The wire types come straight from the generated core and are re-exported: `Job`, `JobConfig`, `JobStatus`, `BackoffStrategy`, `Workflow`, `WorkflowStep`, `WorkflowStepState`, `WorkflowStatus`, `OnFailure`, `OnSuccess`, `LeasedJob`, `CronSchedule`, `DeadLetter`, `StatsSnapshot`, `QueueStats`, the list response types, `HealthStatus`, and `ReadyStatus`. The facade's own types are exported too: `QueueFlowOptions`, `CreateJobInput`, `CreateCronInput`, `ListOptions`, `WaitOptions`, `StepOptions`, `WorkerHandler`, `WorkerContext`, `WorkerRunOptions`, and `WorkerRunResult`.

## Conformance tests

`test/live.mjs` runs the facade against a real QueueFlow server started with the default `queueflow serve` (`--mode all`, so the built-in `echo` handler is registered). It creates and waits on an `echo` job, checks idempotent re-creation, runs a two-step workflow, exercises the cron and dead-letter endpoints, reads stats, and runs `qf.worker.run()` against a dedicated queue. It is skipped unless `QUEUEFLOW_URL` is set, so `npm test` and CI stay offline.

```bash
QUEUEFLOW_URL=http://localhost:8000 \
QUEUEFLOW_TOKEN=dev \
QUEUEFLOW_WORKER_TOKEN=worker-secret \
npm run test:live
```

`QUEUEFLOW_TOKEN` is the tenant token (default `dev`). `QUEUEFLOW_WORKER_TOKEN` is the server's `--worker-token`; it defaults to the tenant token, which only works when the server runs without one.

## A complete example

[queueflow-nodejs-example](https://github.com/elision-labs/queueflow-nodejs-example) is an Express service that enqueues a welcome email on signup, runs the handler in a TypeScript worker, streams job status over SSE, builds a report workflow with `wf()`, and maps SDK errors to HTTP status codes. `make demo` brings up Postgres, the engine, and a smoke test. See [Examples](/examples).
