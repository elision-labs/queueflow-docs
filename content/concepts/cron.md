---
title: Cron schedules
description: Recurring enqueues from standard crontab expressions, evaluated in UTC, deduplicated across servers, with pause and resume.
---

A cron schedule enqueues a job on a recurring timetable. Expressions are standard 5-field crontab (`minute hour day-of-month month day-of-week`) evaluated in **UTC**; a 6- or 7-field form with leading seconds is also accepted. Schedules belong to a tenant and their names are unique within it.

## Creating a schedule

```bash
curl -s -X POST http://localhost:8000/api/v1/cron \
  -H 'Authorization: Bearer <tenant-token>' -H 'Content-Type: application/json' \
  -d '{
    "name": "abandoned-cart-sweep",
    "cron_expr": "*/5 * * * *",
    "task_name": "sweep_abandoned_carts",
    "payload": { "older_than_minutes": 30 },
    "queue": "maintenance",
    "config": { "max_retries": 1, "timeout_secs": 120 }
  }'
# 201 {"cron_id":"c_7f…"}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique per tenant. Creating a second schedule with the same name is a `409`. |
| `cron_expr` | yes | The crontab expression, UTC. An unparseable expression is a `400`. |
| `task_name` | yes | Handler to enqueue on each firing. |
| `payload` | no | JSON object sent with every firing. |
| `queue` | no | Destination queue; the server default when absent. |
| `config` | no | Partial [job configuration](/concepts/jobs#job-configuration) applied to each enqueued job. Note that cron uses the stored-job field names, so the timeout is `timeout_secs`. |

The first firing is the next occurrence after creation. The schedule record reports it as `next_run_at`.

```json
{
  "id": "c_7f…",
  "name": "abandoned-cart-sweep",
  "cron_expr": "*/5 * * * *",
  "task_name": "sweep_abandoned_carts",
  "payload": { "older_than_minutes": 30 },
  "queue_name": "maintenance",
  "config": { "max_retries": 1, "timeout_secs": 120, … },
  "enabled": true,
  "next_run_at": "2026-10-06T12:05:00Z",
  "last_enqueued_at": null,
  "created_at": "2026-10-06T12:01:13Z",
  "tenant_id": "acme"
}
```

## Firing semantics

- **Exactly one job per occurrence, across any number of servers.** Every `worker`- or `all`-mode process runs the cron scheduler, and each firing is enqueued under a per-firing idempotency key, so concurrent schedulers collapse to a single job.
- **Missed occurrences collapse into at most one catch-up firing.** If no scheduler was running for an hour, the schedule fires once when one comes back, then resumes its normal cadence. It does not replay every missed slot.
- **Firings are ordinary jobs.** They appear in `GET /api/v1/jobs` with the schedule's task, payload, queue, and config, and they retry and dead-letter like any other job.

## Pause, resume, delete

| Endpoint | Effect |
| --- | --- |
| `POST /api/v1/cron/{id}/pause` | No further firings until resumed. `enabled` becomes `false`. |
| `POST /api/v1/cron/{id}/resume` | Fires at its **next future** occurrence. Occurrences missed while paused are not caught up. |
| `DELETE /api/v1/cron/{id}` | Removes the schedule. Jobs it already enqueued are unaffected. |

All three return `204`.

## Listing

`GET /api/v1/cron` pages through a tenant's schedules with the shared `limit`, `offset`, `cursor`, `include_total`, `created_after`, and `created_before` parameters. The `status` and `queue` filters do not apply to schedules. `GET /api/v1/cron/{id}` fetches one.

## From the CLI and SDKs

```bash
queueflow cron create --name nightly-report --schedule "0 2 * * *" --task build_report --payload '{"format":"pdf"}'
queueflow cron list
queueflow cron pause <id>
queueflow cron resume <id>
queueflow cron delete <id>
```

```ts
const schedule = await qf.cron.create({ name: "nightly-report", schedule: "0 2 * * *", task: "build_report", payload: { format: "pdf" } });
await qf.cron.pause(schedule.id);
```

The Python, Go, and Rust SDKs expose the cron endpoints through their generated `CronApi` / `CronAPI` clients.

## Expression examples

| Expression | Fires |
| --- | --- |
| `*/5 * * * *` | Every five minutes |
| `0 * * * *` | At the top of every hour |
| `0 2 * * *` | Daily at 02:00 UTC |
| `0 9 * * 1-5` | Weekdays at 09:00 UTC |
| `0 0 1 * *` | First day of each month at midnight UTC |
| `30 * * * * *` | Every minute at 30 seconds past (6-field form) |

Timezones are not supported in the expression; convert your local schedule to UTC.
