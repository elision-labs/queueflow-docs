---
title: Retries, timeouts and the DLQ
description: How QueueFlow decides whether to retry a failed job, how long to wait, when to give up, and how dead-lettered jobs are inspected and replayed.
---

Every job carries its own retry policy, and every retry is persisted as a row scheduled in the future. Nothing about retrying lives in a process's memory, so backoff survives restarts, works across many servers, and is visible in the database.

## Attempts and failures

A job's first attempt plus `max_retries` further attempts make up its budget. An attempt ends in one of three ways:

| Outcome | What happens |
| --- | --- |
| **Success** | The handler returns a JSON object. The job becomes `completed` with that `result`. |
| **Retryable failure** | The handler reports an error with `retryable: true` (the default for `/fail`), throws, panics, or times out. If retries remain, the job becomes `retrying` with `scheduled_at` set to the backoff instant. Otherwise it becomes `failed` and is dead-lettered with reason `max_attempts_exceeded`. |
| **Non-retryable failure** | The handler reports `retryable: false`. The job becomes `failed` immediately and is dead-lettered with reason `non_retryable`, regardless of remaining budget. Use this for bad input and other permanent errors so they do not burn retries. |

A `failed` job is also dead-lettered when no handler exists for its task (`handler_not_found`).

In the TypeScript and Python SDKs, raising `NonRetryableError` from a handler reports `retryable: false`. In the Rust worker runtime the handler's error type decides. Over the raw protocol, send `{"lease_token": "…", "error": "…", "retryable": false}` to `POST /api/v1/jobs/{id}/fail`.

## Backoff

The delay before attempt `n` (zero-based retry index) is computed from the job's config and then capped:

| `retry_backoff` | Delay before retry `n` |
| --- | --- |
| `fixed` | `retry_delay_secs` |
| `linear` | `retry_delay_secs × (n + 1)` |
| `exponential` | `retry_delay_secs × 2^n` |

The result is capped at `retry_max_delay_secs` (default 3600, so the cap applies to every strategy), then jittered by `jitter_factor`: with `0.1`, the final delay is drawn uniformly from 90 to 110 percent of the capped value, which spreads out thundering-herd retries. The jittered value is rounded to whole seconds.

With the defaults (60 second base, exponential, one hour cap, 10 percent jitter), the three retries wait about 1, 2, and 4 minutes: 54 to 66 seconds, 108 to 132 seconds, and 216 to 264 seconds. The Ship-It demo's payment step uses `retry_delay_secs: 2`, `max_retries: 4`, `retry_max_delay_secs: 15`, and `jitter_factor: 0.2`, so its four retries are computed as 2, 4, 8, and 16 seconds, the last is capped to 15, and each is then jittered by up to 20 percent either way: roughly 2, 4, 8, and 15 seconds, never more than 18.

```json
{
  "task_name": "charge_payment",
  "payload": { "order_id": "o_123" },
  "config": {
    "max_retries": 4,
    "retry_backoff": "exponential",
    "retry_delay_secs": 2,
    "retry_max_delay_secs": 15,
    "jitter_factor": 0.2
  }
}
```

The job's `scheduled_at` (and `next_retry_at`) show exactly when the next attempt becomes claimable.

## Timeouts

`timeout` (stored as `timeout_secs`, default 300) is the per-attempt limit for in-process handlers. The engine aborts a handler that exceeds it and treats the attempt as a retryable failure.

Remote workers are governed by the **lease** instead. A worker leases a job for `lease_secs` (default 30, maximum 3600) and must heartbeat before it expires. If it does not, the janitor, which sweeps every 5 seconds, reclaims the job and routes it through the same failure policy as a retryable failure: a retry is scheduled if budget remains, otherwise the job is dead-lettered. The job's `delivery_count` increments on every claim, so a `delivery_count` higher than `retry_count + 1` is the signature of a crashed worker.

Because leases rather than timeouts bound remote work, a long-running remote handler simply heartbeats for as long as it needs, extending its lease by up to 3600 seconds at a time.

## The dead-letter queue

A job that becomes `failed` gets an entry in the dead-letter queue (DLQ). The original job row stays in place, subject to [retention](/configuration#retention); the dead letter records why it died and, once replayed, which new job took its place.

```json
{
  "id": 17,
  "job_id": "0b3d5e5a-…",
  "queue_name": "orders",
  "task_name": "fraud_check",
  "reason": "non_retryable",
  "error_message": "fraud screen rejected order",
  "created_at": "2026-10-06T12:01:00Z",
  "replayed_at": null,
  "replay_job_id": null,
  "tenant_id": "acme"
}
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/dlq` | List dead letters, newest first, with the same `limit`, `offset`, `cursor`, `queue`, `include_total`, and time-range parameters as job listing. |
| `GET /api/v1/dlq/{id}` | One entry. Note that dead-letter ids are integers, unlike job ids. |
| `POST /api/v1/dlq/{id}/replay` | Create a fresh job with the same task, payload, queue, and config. Returns `201 {"job_id": "…"}`. |

Replay semantics:

- Each dead letter replays **at most once**. A second replay returns `409`.
- The replayed job is a **fresh, detached job**: a new id, a full retry budget, and no link to the original workflow. If the dead-lettered job was a workflow step, replaying it does not advance the workflow. Re-create the workflow instead.
- If retention has already deleted the original job, replay returns `404`.

From the CLI: `queueflow dlq list`, `queueflow dlq get <id>`, `queueflow dlq replay <id>`.

## Observing failures

- `GET /api/v1/stats` returns counters for the caller's tenant, including `jobs_retried`, `jobs_failed`, and `jobs_dead_lettered`.
- The Prometheus endpoint exposes `queueflow_jobs_retried_total`, `queueflow_jobs_failed_total`, and `queueflow_jobs_dead_lettered_total`.
- `GET /api/v1/jobs?status=retrying` shows what is waiting on backoff; `GET /api/v1/dlq` shows what has given up.

## Designing handlers for at-least-once delivery

Delivery is at-least-once: a worker can crash after doing the work but before reporting, and the job will run again. Three habits keep that safe.

1. **Make handlers idempotent.** Key side effects on something stable such as the job id, the payload's natural key, or an `Idempotency-Key` on any follow-up enqueue.
2. **Classify failures.** Report permanent errors as non-retryable so they reach the DLQ immediately and leave the retry budget for transient ones.
3. **Heartbeat.** Remote handlers should heartbeat at about half the lease interval and stop when the heartbeat response says the job is no longer `running`.
