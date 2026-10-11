---
title: Migrating from Celery
description: A concept map and side-by-side code for moving Python background tasks from Celery and a broker to QueueFlow on PostgreSQL, with the semantic differences that matter.
---

Celery is a Python task library that runs on a message broker (RabbitMQ, Redis, Amazon SQS and others) with an optional result backend. QueueFlow is a server backed by PostgreSQL that your Python code talks to over HTTP, using the [Python SDK](/sdks/python). The task-and-worker shape survives the move; the broker semantics do not, and most of this page is about that.

Everything below uses the `queueflow` package 0.2.2 against a 0.2.0 server. Only APIs that exist in the SDK are shown.

## Concept mapping

| Celery | QueueFlow | Notes |
| --- | --- | --- |
| `@app.task` function | A handler in the `handlers` dict passed to `run_worker` | Keyed by task name; the server stores `task_name`. |
| `task.delay(*args)` / `apply_async(args=…)` | `qf.create_job(task, payload={…})` | Payload is a JSON object, not positional args. |
| `apply_async(queue="x")` | `queue="x"` | Queues are implicit; no exchange or routing-key configuration. |
| `apply_async(countdown=…)` / `eta=…` | `run_at=` (a `datetime`) | An instant. Survives restarts because it is a row. |
| `apply_async(task_id=…)` | `idempotency_key=` | Different purpose; see [Idempotency](#idempotency-task_id-versus-idempotency-key). |
| `max_retries` (default 3) | `max_retries` (default 3) | Both count retries after the first attempt. |
| `default_retry_delay` (default 180 s) | `retry_delay_secs` (default 60) | Seconds in both. |
| `autoretry_for`, `retry_backoff`, `retry_backoff_max`, `retry_jitter` | Any exception retries; `retry_backoff`, `retry_max_delay_secs`, `jitter_factor` | Retrying is the default, not opt-in. |
| `self.retry()` | Raise any exception | The engine schedules the retry; the handler does not. |
| `Reject`, or not retrying permanent errors | `NonRetryableError` | Dead-letters immediately. |
| `acks_late=True` | Always | QueueFlow is at-least-once with no at-most-once mode. |
| `visibility_timeout` (Redis broker) | Lease and heartbeat | See [Visibility timeout versus lease](#visibility-timeout-versus-lease-token). |
| `time_limit`, `soft_time_limit` | `timeout` (in-process handlers only), `ctx.cancelled` | See [Time limits](#time-limits). |
| Celery beat, `beat_schedule`, `crontab(...)` | `qf.create_cron(name, schedule, task)` | No separate scheduler process. |
| Result backend, `AsyncResult.get()` | `qf.wait_for_job(job.id).result` | Results are stored on the job row. |
| Canvas: `chain`, `group`, `chord` | Workflows (`wf()` with `after=`) | Static DAG only. |
| Flower | No dashboard yet (in progress) | Use the API, the CLI, or SQL. |
| Broker + result backend | PostgreSQL 13 or newer, no extensions | One system to run. |

## Enqueue

```python
# Celery
from proj.celery import app

@app.task
def send_welcome(to):
    ...

send_welcome.delay("ada@example.com")
send_welcome.apply_async(args=["ada@example.com"], queue="emails", countdown=300)
```

```python
# QueueFlow
from datetime import datetime, timedelta, timezone
from queueflow.facade import QueueFlow

qf = QueueFlow("http://localhost:8000", TENANT_TOKEN)

qf.create_job("send_welcome", payload={"to": "ada@example.com"}, queue="emails")
qf.create_job(
    "send_welcome",
    payload={"to": "ada@example.com"},
    queue="emails",
    run_at=datetime.now(timezone.utc) + timedelta(minutes=5),
)
```

`create_job` returns the full `Job` after a follow-up fetch. Arguments become a JSON object; there are no positional args, and nothing is pickled.

## Worker

```python
# Celery
@app.task(bind=True, autoretry_for=(ConnectionError,), max_retries=5, retry_backoff=True)
def send_welcome(self, to):
    if not to:
        return  # or raise Reject(...) with acks_late
    deliver(to)
    return {"sent": True}

# $ celery -A proj worker -Q emails
```

```python
# QueueFlow
import signal, threading
from queueflow.facade import QueueFlow, NonRetryableError

qf = QueueFlow("http://localhost:8000", TENANT_TOKEN, worker_token=WORKER_TOKEN)

def send_welcome(job):
    to = job.payload.get("to")
    if not to:
        raise NonRetryableError("no recipient")   # straight to the dead-letter queue
    deliver(to)                                    # any other exception retries per the job's policy
    return {"sent": True}

stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())

qf.run_worker("emails", {"send_welcome": send_welcome}, stop=stop)
```

Differences to notice:

- The retry policy lives on the job (`max_retries`, backoff fields), set by the producer, not in the task decorator. The server computes the next attempt time; the handler just raises.
- `run_worker` drains one queue per call, one job at a time. For `celery worker -Q a,b -c 8`, run several `run_worker` threads or processes. There is no prefetch multiplier and no concurrency pool.
- The worker authenticates with the server's **worker token**, which is not a tenant token. Without `worker_token=` the SDK reuses the tenant token, which only works against a `--dev` server; a production server returns `403` and `run_worker` raises. See [Authentication and tenants](/concepts/auth#the-worker-credential).
- A leased job whose task name has no handler is failed as non-retryable and dead-lettered, so a typo does not block the queue the way an unregistered Celery task does.

## Retries and backoff

Celery retries only when the task asks (`self.retry()`) or is configured to (`autoretry_for`). `retry_backoff=True` gives 1, 2, 4, 8 seconds and so on, capped by `retry_backoff_max` (default 600) and randomized by `retry_jitter` (default `True`). QueueFlow retries every exception unless it is non-retryable, with `exponential` backoff by default: `retry_delay_secs * 2^n`, capped at `retry_max_delay_secs` (default 3600), jittered by `jitter_factor` (default 0.1, meaning plus or minus 10 percent).

```python
# Celery: up to 5 retries, exponential from 1s, capped at 10 minutes
@app.task(autoretry_for=(Exception,), max_retries=5, retry_backoff=True, retry_backoff_max=600)
def f(): ...

# QueueFlow: the same shape, decided at enqueue time
qf.create_job("f", max_retries=5, retry_backoff="exponential", retry_delay_secs=1, retry_max_delay_secs=600)
```

QueueFlow also has `fixed` and `linear`. The default base delay is 60 seconds, so a job created with no retry fields waits about a minute before its first retry, not three minutes as in Celery and not immediately. See [Retries, timeouts and the DLQ](/concepts/retries#backoff).

## Scheduled and recurring jobs

```python
# Celery beat
from celery.schedules import crontab

app.conf.beat_schedule = {
    "nightly-report": {"task": "tasks.build_report", "schedule": crontab(hour=2, minute=0), "args": ("pdf",)},
}
app.conf.timezone = "UTC"
# $ celery -A proj beat     (exactly one beat process)
```

```python
# QueueFlow
schedule_id = qf.create_cron("nightly-report", "0 2 * * *", "build_report", payload={"format": "pdf"})

qf.cron.pause_cron(schedule_id)
qf.cron.resume_cron(schedule_id)
qf.cron.delete_cron(schedule_id)
```

Differences:

- There is no beat process to run and no single-scheduler constraint. Every `worker`- or `all`-mode QueueFlow process runs the cron scheduler, and firings are deduplicated with per-firing idempotency keys, so any number of them produce exactly one job per occurrence.
- Schedules are data, created and paused through the API, not configuration loaded at process start.
- Expressions are 5-field crontab (6- and 7-field with seconds are accepted) in UTC only. Celery's `timezone` setting has no equivalent; convert.
- A long outage collapses into one catch-up firing rather than replaying every missed slot. See [Cron schedules](/concepts/cron#firing-semantics).

## Canvas versus workflows

A Celery `chain` is a linear dependency, a `group` is parallel fan-out, and a `chord` is a group followed by a callback that receives the results. A QueueFlow workflow expresses all three as a static DAG; each step reads upstream results from the `_context` key of its payload and returns a dict that becomes `_context[<step name>]` downstream.

```python
# Celery
from celery import chord
chord([fetch_sales.s(), fetch_costs.s()])(assemble_report.s())
```

```python
# QueueFlow
from queueflow.facade import wf

dag = (
    wf("monthly-report")
    .step("fetch_sales", "fetch_sales")
    .step("fetch_costs", "fetch_costs")
    .step("assemble", "assemble_report", after=["fetch_sales", "fetch_costs"], on_failure="halt")
)
run = qf.create_workflow(dag)
finished = qf.wait_for_workflow(run.id, timeout=300)
print(finished.status, finished.context)
```

```python
def assemble_report(job):
    ctx = job.payload["_context"]
    return {"total": ctx["fetch_sales"]["amount"] - ctx["fetch_costs"]["amount"]}
```

What does not carry over: a `group` whose size is decided at runtime, a `chord` over a dynamic list, and `chain`s that build further canvases from inside a task. QueueFlow workflows have no dynamic fan-out, sub-workflows, or conditional steps yet; a step can enqueue ordinary jobs from its handler to emulate fan-out. Workflow steps always run on the server's default queue. See [Workflows](/concepts/workflows#current-limits).

## Semantic differences that matter

### Delivery: `acks_late` is always on

By default Celery acknowledges a message just before the task runs, so a worker that crashes mid-task loses it: at-most-once. `acks_late=True` (plus `task_reject_on_worker_lost` for killed child processes) moves to at-least-once. QueueFlow has only the second mode. A job is `running` while a worker holds its lease; if the worker crashes, the janitor reclaims the job and it is retried. Every handler must therefore be idempotent, as Celery's own documentation recommends for `acks_late`.

### Visibility timeout versus lease token

With the Redis broker, an unacknowledged message is redelivered after `visibility_timeout` (default one hour). This is the source of a well-known Celery failure mode: a task scheduled with `eta` or `countdown` further out than the visibility timeout is redelivered and runs again, "and again in a loop" in the words of the Celery docs, and the recommended fix is to raise the timeout for the whole deployment.

QueueFlow separates the two concepts:

- Scheduling is a `scheduled_at` column. A job due next week is simply a row no worker can claim until then. Nothing times out.
- Execution is a lease of `lease_secs` (default 30, maximum 3600) with a `lease_token`. The SDK heartbeats at half the lease interval, so a handler can run for hours without configuration. If the worker dies, the janitor (sweeping every 5 seconds) reclaims the job after the lease expires and routes it through the retry policy. Every heartbeat, complete, and fail call must present the current token; a stale one is a `409`, so a worker that was presumed dead cannot overwrite a job that has since been retried or completed elsewhere.

Each reclaim consumes one unit of retry budget (`delivery_count` exceeds `retry_count + 1`), so a handler that always crashes ends in the dead-letter queue instead of looping.

### Time limits

Celery's `time_limit` kills the worker process and `soft_time_limit` raises `SoftTimeLimitExceeded` inside the task. QueueFlow's `timeout` (default 300 seconds) applies to in-process Rust handlers only. Python handlers run under `run_worker` are bounded by the lease and heartbeat instead: there is no hard kill. If the job is cancelled mid-run, or the lease is lost, the runtime sets `ctx.cancelled` and discards whatever the handler returns; long loops should check it and stop. Enforce your own deadline inside the handler if you need one.

### Idempotency: `task_id` versus `Idempotency-Key`

Celery lets you set `task_id` but does not deduplicate on it; two calls with the same id are two deliveries. QueueFlow's `idempotency_key` is sent as an `Idempotency-Key` header, scoped to the tenant: a repeat `create_job` with the same key returns the **original job** instead of creating a second one, for as long as the original row exists. Use it on anything a retrying HTTP client or an at-least-once consumer might submit twice.

### Failure handling and the dead-letter queue

Celery has no dead-letter queue of its own. A task that exhausts `max_retries` re-raises, the failure is recorded in the result backend if one is configured, and the message is gone. In QueueFlow a job that exhausts its retries becomes `failed` and gets a dead-letter entry with a `reason` (`max_attempts_exceeded`, `non_retryable`, `handler_not_found`) and the last `error_message`. `qf.dlq.list_dead_letters()` inspects them; `qf.replay_dead_letter(id)` creates a fresh job with the same task, payload, queue, and config. Each entry replays at most once. See [The dead-letter queue](/concepts/retries#the-dead-letter-queue).

### Results

Celery stores results only if a result backend is configured, with its own expiry. QueueFlow stores the handler's returned dict on the job row as `result`, readable with `qf.jobs.get_job(id)` or `qf.wait_for_job(id)`, and keeps it until `--retention-hours` deletes the row (never, by default). Return small summaries; for workflow steps the result is copied into every downstream payload.

### What Celery has that QueueFlow does not

- A choice of brokers and the ability to run on an existing RabbitMQ or SQS deployment.
- Worker concurrency pools (prefork, eventlet, gevent), prefetch tuning, and rate limits (`rate_limit`). QueueFlow has none of these; run more worker processes, and expect rate limiting later.
- Dynamic canvases.
- Flower and a large ecosystem of monitoring integrations. QueueFlow exposes Prometheus metrics and a REST API; the dashboard is in progress.
- Signals and task hooks.

## Checklist

1. Start a server with real credentials (`--api-keys` or `--jwt-secret`, plus `--worker-token`); see [Installation](/installation).
2. Turn each `@app.task` into a plain function taking `job` (or `job, ctx`) and register it by name in the `handlers` dict of `run_worker`.
3. Replace `delay` / `apply_async` with `create_job`, converting positional args to a payload dict, `countdown`/`eta` to `run_at`, and the decorator's retry settings to per-job fields.
4. Raise `NonRetryableError` where you previously declined to retry.
5. Move `beat_schedule` entries to `create_cron` and delete the beat process.
6. Rebuild chains, groups, and chords as `wf()` DAGs, reading upstream results from `payload["_context"]`.
7. Audit handlers for idempotency; QueueFlow is `acks_late` for everything.

## Sources

Celery documentation, checked 2026-10-10:

- <https://docs.celeryq.dev/en/stable/getting-started/introduction.html> (brokers, Python versions)
- <https://docs.celeryq.dev/en/stable/userguide/tasks.html> (retries, `acks_late`, time limits, idempotence)
- <https://docs.celeryq.dev/en/stable/userguide/calling.html> (`countdown`, `eta`, `expires`, `queue`, `task_id`)
- <https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html> (beat, `crontab`, single scheduler)
- <https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html> (visibility timeout caveat)
