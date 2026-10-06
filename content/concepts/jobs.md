---
title: Jobs
description: The unit of work in QueueFlow. How a job is created, configured, scheduled, claimed, observed, and cancelled.
---

A job is one invocation of a named task handler with a JSON payload. It lives as a row in `queueflow.jobs` from creation until it reaches a terminal state, and that row is also the queue entry: a job is "on the queue" when its status is `pending` or `retrying` and its `scheduled_at` is not in the future.

## Anatomy

```json
{
  "id": "0b3d5e5a-…",
  "queue_name": "default",
  "task_name": "resize_image",
  "payload": { "image_id": 42 },
  "config": {
    "priority": 5,
    "max_retries": 3,
    "timeout_secs": 30,
    "retry_backoff": "exponential",
    "retry_delay_secs": 60,
    "retry_max_delay_secs": 3600,
    "jitter_factor": 0.1
  },
  "status": "completed",
  "result": { "width": 800, "height": 600 },
  "error_message": null,
  "retry_count": 0,
  "delivery_count": 1,
  "created_at": "2026-10-06T12:00:00Z",
  "scheduled_at": "2026-10-06T12:00:00Z",
  "started_at": "2026-10-06T12:00:00.120Z",
  "completed_at": "2026-10-06T12:00:01.900Z",
  "next_retry_at": null,
  "idempotency_key": "resize:42",
  "workflow_id": null,
  "workflow_step_id": null,
  "tenant_id": "acme",
  "metadata": {}
}
```

| Field | Meaning |
| --- | --- |
| `task_name` | The handler to run. Either a handler registered in the server, or a name your remote worker understands. |
| `queue_name` | Workers lease from one queue at a time. Defaults to the server's `--default-queue`. |
| `payload` | Arbitrary JSON object handed to the handler. Workflow steps additionally receive `_context`. |
| `config` | Execution policy. See [Job configuration](#job-configuration). |
| `status` | One of `pending`, `running`, `retrying`, `completed`, `failed`, `cancelled`. |
| `result` | The JSON object returned by the handler on success. For workflow steps it is merged into the workflow context. |
| `error_message` | The last reported failure. |
| `retry_count` | Retries consumed so far. |
| `delivery_count` | How many times a worker has claimed this job. A value greater than `retry_count + 1` means a lease expired without a report, that is, a worker crashed mid-run. |
| `scheduled_at` | When the job becomes claimable: `created_at` for immediate jobs, the requested `run_at` for scheduled jobs, and the next backoff instant while retrying. |
| `next_retry_at` | Mirrors `scheduled_at` while the job is `retrying`; kept for inspection. |
| `idempotency_key` | The client-supplied key, if any, that makes creation idempotent per tenant. |
| `workflow_id`, `workflow_step_id` | Set when the job executes a workflow step. Steps are addressed by name. |
| `tenant_id` | The tenant that owns the job. Every read is scoped to the caller's tenant. |

## Lifecycle

```text
                 run_at reached / created            claimed by a worker
   ┌─────────┐ ─────────────────────────────► ┌─────────┐ ──────────────► ┌─────────┐
   │ pending │                                 │ pending │                 │ running │
   └─────────┘                                 └─────────┘                 └────┬────┘
     (future scheduled_at: invisible to claims)                                 │
                                                                                 │ complete
                       ┌────────────┐  retries left, backoff elapsed             ├───────────► completed
   fail (retryable) ◄──┤  retrying  │ ◄──────────────────────────────────────────┤
                       └────────────┘                                            │ fail (retryable=false)
                                                                                 │ or retries exhausted
                                                                                 ├───────────► failed  ──► dead-letter queue
                                                                                 │ cancel
                                                                                 └───────────► cancelled
```

- **`pending`**: created and waiting. If `scheduled_at` is in the future, the row exists but no worker can claim it yet.
- **`running`**: a worker holds the lease. The lease token in the row must match on every heartbeat, complete, or fail call.
- **`retrying`**: the last attempt failed and a retry is scheduled. `scheduled_at` holds the backoff instant, so the delay survives restarts.
- **`completed`**, **`failed`**, **`cancelled`**: terminal. Terminal jobs are never re-queued or retried. A `failed` job also gets an entry in the [dead-letter queue](/concepts/retries#the-dead-letter-queue), from which it can be replayed as a fresh job.

A job whose lease expires without a report (a crashed worker) is reclaimed by the janitor and routed through the normal failure policy. It consumes retry budget rather than crash-looping. Workers that heartbeat keep the lease alive for as long as the work takes.

## Creating a job

```bash
curl -s -X POST http://localhost:8000/api/v1/jobs \
  -H 'Authorization: Bearer <tenant-token>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: resize:42' \
  -d '{
    "task_name": "resize_image",
    "payload": { "image_id": 42 },
    "config": { "queue": "images", "priority": 5, "max_retries": 3, "timeout": 30 },
    "run_at": "2026-10-06T15:00:00Z"
  }'
# 201 {"job_id":"0b3d5e5a-…"}
```

The create response carries only the id. Fetch the job with `GET /api/v1/jobs/{id}` if you need the full record; the SDKs' `create()` helpers do this for you.

### Job configuration

All fields are optional. Omitted fields take the defaults below, which also apply to workflow steps and cron schedules whose `config` is partial.

| Field (request) | Default | Meaning |
| --- | --- | --- |
| `queue` | server `--default-queue` | Destination queue. Only valid on single and batch creates; workflow steps always run on the default queue. |
| `priority` | `0` | Higher is claimed first within a queue. Ties break on `scheduled_at`, then `created_at`. |
| `max_retries` | `3` | Retries after the first attempt. `0` means a single attempt. Maximum 1000. |
| `timeout` | `300` | Per-attempt timeout in seconds for in-process handlers. Maximum 86400. Appears as `timeout_secs` on the stored job. |
| `retry_backoff` | `exponential` | `fixed`, `linear`, or `exponential`. See [Retries](/concepts/retries#backoff). |
| `retry_delay_secs` | `60` | Base delay between attempts. Maximum 2592000 (30 days). |
| `retry_max_delay_secs` | `3600` | Cap on any computed delay. Maximum 2592000. |
| `jitter_factor` | `0.1` | Randomization of each delay in `0.0..=1.0`; `0.1` means plus or minus 10 percent. |

Out-of-range values are rejected with a `400` at the API boundary.

### Scheduling for later

Set `run_at` to an RFC 3339 instant. The job is created immediately but stays invisible to workers until then. Because the delay lives in the row, it survives server restarts and works across any number of processes. The Ship-It demo uses this to schedule a review request 90 seconds after an order completes.

### Idempotent creation

Send an `Idempotency-Key` header. A second create with the same key, from the same tenant, returns the original job id with a `201` instead of creating a duplicate. Use it whenever the caller might retry: HTTP clients with retry policies, at-least-once message consumers, and handlers that enqueue follow-up jobs.

### Batch creation

`POST /api/v1/jobs/batch` takes `{"jobs": [CreateJobRequest, …]}` and creates up to 1000 jobs in one round trip, returning `{"job_ids": […], "count": n}`. Each item may carry its own `config` and `run_at`. Batch items do not take an idempotency key.

## Reading jobs

### Fetch one

`GET /api/v1/jobs/{id}` returns the full job. A job owned by another tenant is a `403`; an unknown id is a `404`.

### List and filter

```bash
curl -s 'http://localhost:8000/api/v1/jobs?status=retrying&queue=images&limit=50&include_total=true' \
  -H 'Authorization: Bearer <tenant-token>'
```

| Query parameter | Meaning |
| --- | --- |
| `status` | Filter by status, for example `pending` or `failed`. |
| `queue` | Filter by queue name. |
| `limit` | Page size, 1 to 100. Default 50. |
| `offset` | Rows to skip. Default 0. Prefer `cursor` for deep pages. |
| `cursor` | Opaque keyset cursor from the previous page's `next_cursor`. When set, `offset` is ignored. |
| `order_by` | `created_at DESC` (default) or `created_at ASC`. |
| `include_total` | Also compute the exact total. Costs a count over the filtered set, so it is opt-in. |
| `created_after`, `created_before` | RFC 3339 bounds forming the half-open range `[after, before)`, the natural shape for walking history period by period. |

Responses carry `has_more` and, when there is another page, `next_cursor`. Keyset pagination is much cheaper than a deep `OFFSET`, so loop on `next_cursor` for anything beyond the first few pages.

### Stream status changes

`GET /api/v1/jobs/{id}/events` is a Server-Sent Events stream. Each `status` event carries the full job JSON. The stream closes once the job is terminal, or after 15 minutes, whichever comes first.

```bash
curl -N http://localhost:8000/api/v1/jobs/<id>/events -H 'Authorization: Bearer <tenant-token>'
```

```text
event: status
data: {"id":"…","status":"running",…}

event: status
data: {"id":"…","status":"completed",…}
```

The TypeScript SDK exposes this as `for await (const job of qf.jobs.watch(id))`. The generated Python, Go, and Rust clients cannot consume SSE; use their polling `wait_for` helpers instead.

## Cancelling

`POST /api/v1/jobs/{id}/cancel` marks a `pending` or `retrying` job `cancelled` so it is never claimed. For a `running` job the cancellation is recorded immediately and the worker learns about it at its next heartbeat, whose response status is no longer `running`; well-behaved workers then abandon the handler and report nothing. A cancelled job does not enter the dead-letter queue.

## In-process handlers

When `queueflow serve` runs in `all` or `worker` mode, jobs on the default queue are executed by handlers compiled into the binary. The stock binary registers four handlers useful for smoke tests: `echo` (returns its payload), `log`, `sleep`, and `fail`. `GET /api/v1/tasks` lists them. To register your own Rust handlers, embed the engine as a library; see [Rust](/sdks/rust#embedding-the-engine). For every other language, run a [remote worker](/concepts/workers).

A job whose `task_name` matches no handler on the queue it was claimed from is dead-lettered with reason `handler_not_found`.
