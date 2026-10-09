---
title: TypeScript SDK
description: The @queueflow/sdk package for Node.js and TypeScript. A typed client with resource groups, waiters, an SSE watcher, a workflow builder, a worker runtime, and typed errors.
---

`@queueflow/sdk` is a hand-written facade over a core generated from the server's OpenAPI spec. The wire types and transport are regenerated and never drift; the facade adds the ergonomics codegen cannot express. It has zero runtime dependencies, uses the built-in `fetch`, and ships dual ESM and CommonJS builds with its own type declarations.

- **Requires** Node.js 18 or newer.
- **Source**: [elision-labs/queueflow-sdk-nodejs](https://github.com/elision-labs/queueflow-sdk-nodejs). **Package**: [npm](https://www.npmjs.com/package/@queueflow/sdk), version 0.2.0.

## Install

```bash
npm install @queueflow/sdk
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

Idempotent calls (reads, leases, and creates that carry an idempotency key) are retried on transport failures and gateway errors; non-idempotent calls are not.

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
  queue?: string;
  priority?: number;
  maxRetries?: number;
  timeout?: number;             // seconds
  retryBackoff?: "fixed" | "linear" | "exponential";
  retryDelaySecs?: number;
  retryMaxDelaySecs?: number;
  jitterFactor?: number;
  idempotencyKey?: string;      // sent as the Idempotency-Key header
  runAt?: Date | string;        // don't run before this instant
}
```

`list` options: `status`, `queue`, `limit`, `offset`, `orderBy` (`"created_at ASC" | "created_at DESC"`), `includeTotal`, `cursor`, `createdAfter`, `createdBefore`. Responses carry `next_cursor` when there is another page; pass it back as `cursor`.

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

Step options: `after`, `payload`, `config` (a partial `JobConfig` in wire-format snake_case), `onFailure`, `onSuccess`, `metadata`.

## Worker: `qf.worker`

Run handlers in this process against a remote server:

```ts
await qf.worker.run("emails", {
  "send-email": async (job, ctx) => {
    // ctx.signal aborts when the job is cancelled mid-run or the lease is lost.
    await sendEmail(job.payload, { signal: ctx.signal });
    return { sent: true };
  },
}, {
  leaseSecs: 30,   // default 30
  waitSecs: 20,    // long-poll length, default 20
  signal,          // stop the loop
  onError,         // called on transient lease errors; default is a throttled console.warn
});
```

`run()` leases one job at a time, heartbeats at half the lease interval, stops reporting when the lease is lost, and applies the server's retry policy when a handler throws. Throw `NonRetryableError` (or any error with `retryable: false`) to dead-letter immediately. A `401` or `403` from the lease call is thrown rather than retried, so a missing or wrong `workerToken` fails fast instead of spinning.

The lower-level calls are also exposed: `lease(queue, { maxJobs, leaseSecs, waitSecs })`, `heartbeat(lease, extendSecs)`, `complete(lease, result)`, `fail(lease, error, { retryable })`.

Delivery is at-least-once: make handlers idempotent.

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
```

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
| `ConnectionError` | Network or abort failures in transport. |
| `TimeoutError` | A `waitFor` ran out of time. |
| `AbortError` | A `waitFor` was aborted by its signal. |
| `WorkflowValidationError` | A `wf()` builder failed local validation. |
| `NonRetryableError` | Throw this from a worker handler to dead-letter the job immediately. |

## Types

The wire types come straight from the generated core and are re-exported: `Job`, `JobConfig`, `JobStatus`, `BackoffStrategy`, `Workflow`, `WorkflowStep`, `WorkflowStepState`, `WorkflowStatus`, `OnFailure`, `LeasedJob`, `CronSchedule`, `DeadLetter`, `StatsSnapshot`, the list response types, `HealthStatus`, and `ReadyStatus`.

## A complete example

[queueflow-example-nodejs](https://github.com/sjriddle/queueflow-example-nodejs) is an Express service that enqueues a welcome email on signup, runs the handler in a TypeScript worker, streams job status over SSE, builds a report workflow with `wf()`, and maps SDK errors to HTTP status codes. `make demo` brings up Postgres, the engine, and a smoke test. See [Examples](/examples).
