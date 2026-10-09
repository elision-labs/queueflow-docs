---
title: Python SDK
description: The queueflow package on PyPI. A generated client for every endpoint plus a facade with create, wait_for, a workflow builder, and a run_worker runtime for handlers written in Python.
---

The `queueflow` package is generated from the server's OpenAPI spec with openapi-generator, with a hand-written facade injected at generation time so it is regenerated alongside the core and cannot drift. The facade is the recommended entry point; the generated `queueflow.api.*` clients and `queueflow.models.*` types remain available for everything else.

- **Requires** Python 3.8 or newer. Depends on `urllib3`, `pydantic` 2, `python-dateutil`, and `typing-extensions`.
- **Source**: [elision-labs/queueflow-sdk-python](https://github.com/elision-labs/queueflow-sdk-python). **Package**: [PyPI](https://pypi.org/project/queueflow/), version 0.2.1.

## Install

```bash
pip install queueflow
```

## Quick start

```python
from queueflow.facade import QueueFlow, wf

qf = QueueFlow("http://localhost:8000", "dev")

# Enqueue a job and wait for the result.
job = qf.create_job("echo", payload={"hello": "world"}, max_retries=3)
done = qf.wait_for_job(job.id)
print(done.status, done.result)

# Declare and run a DAG workflow.
dag = (
    wf("etl")
    .step("extract", "echo")
    .step("transform", "echo", after=["extract"])
    .step("load", "echo", after=["transform"])
)
workflow = qf.create_workflow(dag)
finished = qf.wait_for_workflow(workflow.id)
print(finished.status, finished.context)
```

The `"dev"` token only works against a server started with `--dev`. See [the worker token](#the-worker-token) below and [Authentication and tenants](/concepts/auth).

## The facade

`QueueFlow(base_url, token, worker_token=None)` exposes:

| Member | Description |
| --- | --- |
| `create_job(task, payload=None, priority=None, max_retries=None, timeout=None, queue=None, idempotency_key=None) -> Job` | Enqueue, then fetch and return the full job. |
| `wait_for_job(job_id, timeout=60.0, interval=0.5) -> Job` | Poll until `completed`, `failed`, or `cancelled`. Raises `WaitTimeout`. |
| `create_workflow(builder_or_request) -> Workflow` | Create from a `wf()` builder or a `CreateWorkflowRequest`. |
| `wait_for_workflow(workflow_id, timeout=60.0, interval=0.5) -> Workflow` | Poll until a terminal workflow status. Raises `WaitTimeout`. |
| `create_cron(name, schedule, task, payload=None, queue=None) -> str` | Register a recurring enqueue from a five-field crontab expression (UTC). Returns the schedule id. |
| `replay_dead_letter(dead_letter_id) -> Job` | Re-run a dead letter as a fresh job and return the new job. A second replay is a `409`. |
| `run_worker(queue, handlers, lease_secs=30, wait_secs=20, stop=None, on_error=None) -> None` | Lease jobs from `queue` and run them in this process. See [Worker runtime](#worker-runtime). |
| `.jobs`, `.workflows`, `.cron`, `.dlq`, `.system` | The generated `JobsApi`, `WorkflowsApi`, `CronApi`, `DlqApi`, and `SystemApi` clients, authenticated with the tenant token. |
| `.worker` | The generated `WorkerApi`, authenticated with `worker_token` when given. |

`wf(name)` returns a `WorkflowBuilder` whose `.step(name, task_name, after=None, payload=None, config=None, on_failure=None)` adds steps and whose `.build()` validates locally (duplicate names, dangling dependencies, cycles), raising `WorkflowValidationError` before any network round-trip.

## Worker runtime

`run_worker` is a complete remote worker: it leases jobs from one queue, dispatches each to a handler by task name, heartbeats while the handler runs, and reports the outcome. The engine owns retries, backoff, the dead-letter queue, and workflow advancement, so a Python handler gets the same semantics as one compiled into the server.

```python
import signal
import threading
from queueflow.facade import QueueFlow, NonRetryableError

qf = QueueFlow("http://localhost:8000", TENANT_TOKEN, worker_token=WORKER_TOKEN)

def send_email(job):
    if not job.payload.get("to"):
        raise NonRetryableError("no recipient")      # dead-letters immediately
    deliver(job.payload)                             # any other exception retries per policy
    return {"sent": True}

def transcode(job, ctx):
    for chunk in chunks(job.payload):
        if ctx.cancelled:                            # lease lost or job cancelled mid-run
            return None                              # stop; the server owns the outcome now
        process(chunk)
    return {"ok": True}

stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())

qf.run_worker("orders", {"send_email": send_email, "transcode": transcode}, stop=stop)
```

### Signature

```python
qf.run_worker(
    queue: str,
    handlers: dict[str, Callable[..., dict | None]],
    lease_secs: int = 30,
    wait_secs: int = 20,
    stop: threading.Event | None = None,
    on_error: Callable[[Exception], None] | None = None,
) -> None
```

| Parameter | Meaning |
| --- | --- |
| `queue` | The queue to lease from. One `run_worker` call drains one queue; run several threads or processes for several queues. |
| `handlers` | Task name to callable. A leased job whose task name has no entry is failed with `retryable=False` and dead-lettered (`"no worker handler for task '…'"`), so it does not block the queue. |
| `lease_secs` | How long each lease lasts and how much each heartbeat extends it. Jobs are leased one at a time (`max_jobs=1`). |
| `wait_secs` | How long each lease request long-polls when the queue is empty. |
| `stop` | A `threading.Event`. Set it to stop the loop. |
| `on_error` | Called with each lease error instead of the default throttled log line. |

### Handler contract

- A handler is called as `handler(job)` or, if it accepts two or more positional parameters, as `handler(job, ctx)`. `job` is the generated `queueflow.models.Job` (`job.id`, `job.task_name`, `job.payload`, `job.config`, and so on). `ctx` is a `WorkerContext`.
- Return a `dict` to store as the job's `result`; returning `None` stores `{}`. For a workflow step the result is merged into the workflow context.
- Raising any exception fails the attempt as **retryable**: the engine schedules a retry if budget remains, otherwise dead-letters the job with reason `max_attempts_exceeded`.
- Raising `NonRetryableError`, or any exception whose `retryable` attribute is `False`, fails the attempt as **non-retryable**: the job is dead-lettered immediately with reason `non_retryable`, regardless of remaining budget. Use it for bad input and other permanent errors.
- Delivery is at-least-once. A worker can crash after doing the work but before reporting, and the job will run again, so key side effects on `job.id` or a natural key in the payload.

### Heartbeats and cancellation

Each leased job is heartbeated from a background thread every `max(1, lease_secs / 2)` seconds, extending the lease by `lease_secs`, for as long as the handler runs. A long handler never needs to think about the lease.

If a heartbeat reports that the job is no longer `running` (it was cancelled mid-run, or the lease expired and the janitor reclaimed it) or answers `409`, the server owns the outcome. The runtime then sets `ctx.cancelled` to `True` and discards whatever the handler returns or raises; nothing is reported. Handlers that loop over work should check `ctx.cancelled` periodically and stop, because any further work is wasted.

If reporting an outcome fails (the server is unreachable, for example), the runtime logs a warning and does not retry the report. The lease expires and the engine redelivers the job, which is why handlers must be idempotent.

### Stopping

`run_worker` blocks until `stop` is set. It checks the event between lease requests, so after `stop.set()` the loop ends once the current long-poll returns (up to `wait_secs`) and any in-flight handler has finished and reported. There is no built-in signal handling; set the event from your own `SIGTERM`/`SIGINT` handler as in the example above. Without `stop`, the loop runs forever.

### Lease errors

A lease request that fails with `401` or `403` raises `queueflow.ApiException` immediately, because a wrong or missing worker token cannot heal by retrying. Any other lease error (a `5xx`, a network failure) is passed to `on_error` if given, or logged on the first failure and every thirtieth consecutive one after that, and the loop sleeps one second before trying again.

## The worker token

Worker-protocol routes (`lease`, `heartbeat`, `complete`, `fail`) authenticate with the server's **worker token**, not a tenant token, because workers execute every tenant's jobs. Pass it as `QueueFlow(base_url, token, worker_token=...)`; `run_worker` and `qf.worker` then send it on those routes while `qf.jobs`, `qf.workflows`, and the other tenant clients keep using `token`.

Without `worker_token`, `qf.worker` reuses the tenant token. That only works against a server started with `--dev` (or `QUEUEFLOW_DEV=1`); a production server returns `403` and `run_worker` raises. See [Authentication and tenants](/concepts/auth#development-mode).

## Using the generated clients

Anything the facade does not wrap is one call away on the generated clients. They take and return pydantic models from `queueflow.models`:

```python
from queueflow.models import CreateCronRequest

qf.cron.create_cron(CreateCronRequest(
    name="nightly-report",
    cron_expr="0 2 * * *",
    task_name="build_report",
    payload={"format": "pdf"},
))

page = qf.jobs.list_jobs(status="retrying", limit=50)
for job in page.jobs:
    print(job.id, job.next_retry_at)
if page.has_more:
    page = qf.jobs.list_jobs(cursor=page.next_cursor)

dead = qf.dlq.list_dead_letters()
for entry in dead.dead_letters:
    print(entry.id, entry.reason, entry.error_message)
```

The raw worker endpoints are on `qf.worker` (`lease_jobs`, `heartbeat_job`, `complete_job`, `fail_job`) for the rare case where `run_worker` does not fit, for example leasing several jobs per request. A hand-rolled loop must honour the same contract: heartbeat every in-flight job at about half its lease interval, stop when a heartbeat says the job is no longer `running`, and report permanent failures with `retryable=False`. See [Remote workers](/concepts/workers).

Every operation and model is listed in the package's [README](https://github.com/elision-labs/queueflow-sdk-python#documentation-for-api-endpoints) and matches the [REST API reference](/api) one to one, in snake_case.

## Errors

Generated calls raise `queueflow.rest.ApiException` (also importable as `queueflow.ApiException`) with `.status`, `.reason`, and `.body` on any non-2xx response. The facade adds `WaitTimeout` for exhausted waits, `WorkflowValidationError` for a bad builder, and `NonRetryableError` for handlers to raise.

```python
from queueflow import ApiException

try:
    qf.jobs.get_job("missing")
except ApiException as e:
    if e.status == 404:
        ...
```

## Known limitation: `stream_job_events`

`JobsApi.stream_job_events` cannot stream: it buffers the whole SSE response until the server closes it (terminal status or the 15-minute cap). Use `wait_for_job` instead, or call `stream_job_events_without_preload_content` and parse the `text/event-stream` body yourself.
