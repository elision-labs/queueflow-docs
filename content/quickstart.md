---
title: Quick start
description: Start the engine against a local Postgres, enqueue a job, run a workflow, and drain a queue with a worker written in TypeScript.
---

This page takes you from nothing to a running engine with a worker in your own language. You need Docker (for Postgres and, optionally, the engine) and Node.js 18 or newer for the worker step. Every step also works with curl alone.

## 1. Start Postgres

Any plain PostgreSQL 13 or newer works. For a throwaway local instance:

```bash
docker run -d --name qf-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:16-alpine
```

## 2. Start the engine

Pick one. All three start the REST API on port 8000, Prometheus metrics on port 9090, ten in-process workers, and apply the schema migrations on startup. All three pass `--dev`, which turns on [development mode](/concepts/auth#development-mode) so you can use any bearer token; see the warning below.

**With the Docker image**

```bash
docker run --rm -p 8000:8000 -p 9090:9090 \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/postgres \
  ghcr.io/elision-labs/queueflow:0.2 serve --dev
```

The `--add-host` flag is only needed on Linux; Docker Desktop on macOS and Windows resolves `host.docker.internal` on its own.

**With cargo**

```bash
cargo install queueflow

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
queueflow serve --dev --mode all --workers 10 --api-port 8000
```

**With a prebuilt binary**

Download the tarball for your platform from the [latest release](https://github.com/elision-labs/queueflow-core/releases/latest), unpack it, and run the same `queueflow serve` command.

Confirm it is up:

```bash
curl -s http://localhost:8000/health
# {"status":"ok","timestamp":"…","version":"0.2.0"}
```

The interactive Swagger UI is at <http://localhost:8000/docs>.

> **Warning**
> `--dev` (or `QUEUEFLOW_DEV=1`) puts the server in **development mode**: any non-empty bearer token authenticates as the fixed tenant `tenant1`, and any authenticated caller may lease work from the worker routes. The server warns about this at startup. Never expose a `--dev` server to a network you do not control.
>
> Without `--dev`, `serve` in `api` or `all` mode refuses to start until tenant authentication (`--api-keys` and/or `--jwt-secret`) **and** `--worker-token` are configured. To run this quick start with real credentials instead, replace `--dev` with `--api-keys dev:tenant1 --worker-token <secret>` and give the worker in step 5 that secret as `workerToken`. See [Authentication and tenants](/concepts/auth).

## 3. Enqueue a job

The development server registers four built-in handlers on the `default` queue: `echo`, `log`, `sleep`, and `fail`. Enqueue an `echo` job with a priority, a retry budget, and a timeout:

```bash
curl -s -X POST http://localhost:8000/api/v1/jobs \
  -H 'Authorization: Bearer dev' -H 'Content-Type: application/json' \
  -d '{"task_name":"echo","payload":{"hello":"world"},"config":{"priority":5,"max_retries":3,"timeout":30}}'
# {"job_id":"3f1c…"}
```

Fetch it. An in-process worker will already have run it:

```bash
curl -s http://localhost:8000/api/v1/jobs/<job_id> -H 'Authorization: Bearer dev'
```

```json
{
  "id": "3f1c…",
  "queue_name": "default",
  "task_name": "echo",
  "payload": { "hello": "world" },
  "config": { "priority": 5, "max_retries": 3, "timeout_secs": 30, "retry_backoff": "exponential", "retry_delay_secs": 60, "retry_max_delay_secs": 3600, "jitter_factor": 0.1 },
  "status": "completed",
  "result": { "hello": "world" },
  "retry_count": 0,
  "delivery_count": 1,
  "created_at": "…", "scheduled_at": "…", "started_at": "…", "completed_at": "…"
}
```

To wait for a job without polling, stream its status transitions as Server-Sent Events. The stream closes once the job is terminal:

```bash
curl -N http://localhost:8000/api/v1/jobs/<job_id>/events -H 'Authorization: Bearer dev'
```

## 4. Run a workflow

A workflow is a JSON document of named steps and `depends_on` edges. Steps are enqueued only once their dependencies complete, and each step's result is merged into a shared context that downstream steps receive under the `_context` payload key.

```bash
curl -s -X POST http://localhost:8000/api/v1/workflows \
  -H 'Authorization: Bearer dev' -H 'Content-Type: application/json' \
  -d '{
    "name": "etl",
    "steps": [
      { "name": "extract",   "task_name": "echo", "payload": { "rows": 3 } },
      { "name": "transform", "task_name": "echo", "depends_on": ["extract"] },
      { "name": "load",      "task_name": "echo", "depends_on": ["transform"], "on_failure": "halt" }
    ]
  }'
# {"workflow_id":"9a7e…"}

curl -s http://localhost:8000/api/v1/workflows/<workflow_id>/steps -H 'Authorization: Bearer dev'
# {"steps":[{"name":"extract","status":"completed","job_id":"…"}, …]}

curl -s http://localhost:8000/api/v1/workflows/<workflow_id>/diagram -H 'Authorization: Bearer dev'
# {"format":"mermaid","diagram":"graph TD\n    extract[\"extract\"]\n …"}
```

A cycle in `depends_on` is rejected with a `400` at creation. See [Workflows](/concepts/workflows) for failure policies and context propagation.

## 5. Write a worker in TypeScript

Handlers do not have to live in the server. A remote worker leases jobs from a queue over HTTP, heartbeats while it works, and reports the outcome. The TypeScript SDK wraps that protocol in one call.

```bash
mkdir qf-worker && cd qf-worker && npm init -y && npm install @queueflow/sdk
```

```ts
// worker.mjs
import { QueueFlow } from "@queueflow/sdk";

const qf = new QueueFlow({ baseUrl: "http://localhost:8000", token: "dev" });

await qf.worker.run("emails", {
  "send-welcome": async (job, ctx) => {
    // ctx.signal aborts if the job is cancelled mid-run or the lease is lost.
    console.log("sending welcome email to", job.payload.email);
    return { sent: true };
  },
});
```

```bash
node worker.mjs
```

In a second terminal, enqueue a job on the `emails` queue:

```ts
// enqueue.mjs
import { QueueFlow } from "@queueflow/sdk";

const qf = new QueueFlow({ baseUrl: "http://localhost:8000", token: "dev" });
const job = await qf.jobs.create({ task: "send-welcome", payload: { email: "ada@example.com" }, queue: "emails", maxRetries: 3 });
const done = await qf.jobs.waitFor(job.id);
console.log(done.status, done.result); // completed { sent: true }
```

The worker leases one job at a time, heartbeats at half the lease interval, and applies the server's retry policy if your handler throws. Delivery is at-least-once, so make handlers idempotent. The same protocol is available from [Python](/sdks/python), [Go](/sdks/go), [Rust](/sdks/rust), and plain [curl](/concepts/workers).

## 6. Look around

```bash
curl -s http://localhost:8000/api/v1/stats  -H 'Authorization: Bearer dev'   # job and workflow counters for your tenant
curl -s http://localhost:8000/api/v1/tasks  -H 'Authorization: Bearer dev'   # registered in-process handlers
curl -s http://localhost:8000/api/v1/dlq    -H 'Authorization: Bearer dev'   # dead letters (none yet)
curl -s http://localhost:9090/metrics                                        # Prometheus
```

Enqueue a `fail` job with `"config":{"max_retries":1,"retry_delay_secs":1}` and watch it move through `retrying` to `failed` and into the dead-letter queue, then replay it with `POST /api/v1/dlq/{id}/replay`. See [Retries, timeouts and the DLQ](/concepts/retries).

## Clean up

```bash
docker rm -f qf-pg
```

## Next steps

- [Configuration](/configuration): every flag and environment variable.
- [Authentication and tenants](/concepts/auth): drop `--dev` and configure real credentials.
- [Production deployment](/deployment): split API and worker processes, probes, metrics, retention.
