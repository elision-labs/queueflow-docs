---
title: Python SDK
description: The queueflow package on PyPI. A generated client for every endpoint plus a facade with create, wait_for, a workflow builder, and a concurrent run_worker runtime with graceful stop for handlers written in Python.
---

The `queueflow` package is generated from the server's OpenAPI spec with openapi-generator, with a hand-written facade injected at generation time so it is regenerated alongside the core and cannot drift. The facade is the recommended entry point; the generated `queueflow.api.*` clients and `queueflow.models.*` types remain available for everything else.

- **Requires** Python 3.9 or newer. Depends on `urllib3`, `pydantic` 2, `python-dateutil`, and `typing-extensions`.
- **Source**: [elision-labs/queueflow-sdk-python](https://github.com/elision-labs/queueflow-sdk-python). **Package**: [PyPI](https://pypi.org/project/queueflow/), version 0.5.0.

## Install

```bash
pip install queueflow==0.5.0
```

## Quick start

```python
from queueflow.facade import QueueFlow, wf

qf = QueueFlow("http://localhost:8000", "dev")

# Enqueue a job and wait for the result.
job = qf.create_job("echo", payload={"hello": "world"}, max_retries=3, timeout=30)
done = qf.wait_for_job(job.id)
print(done.status, done.result)   # completed {'hello': 'world', 'echoed': True}

# Declare and run a DAG workflow.
dag = (
    wf("etl")
    .step("extract", "echo")
    .step("transform", "echo", after=["extract"])
    .step("load", "echo", after=["transform"], on_failure="halt")
)
workflow = qf.create_workflow(dag)
finished = qf.wait_for_workflow(workflow.id)
print(finished.status, finished.context)
```

`echo` is a handler built into the server; it returns the payload plus `"echoed": true`. The `"dev"` token only works against a server started with `--dev`. See [the worker token](#the-worker-token) below and [Authentication and tenants](/concepts/auth).

## Client

```python
qf = QueueFlow(
    base_url,             # required, e.g. "http://localhost:8000"
    token,                # required: tenant bearer token (any non-empty token on a --dev server)
    worker_token=None,    # credential for qf.worker and run_worker (defaults to token; dev mode only)
    timeout=30.0,         # default per-request timeout in seconds; a (connect, read) pair or None also work
)
```

Any generated api method accepts `_request_timeout=` to override the default for one call. The worker runtime's lease long-poll sets its own timeout of the effective wait plus 35 seconds.

The generated per-tag clients hang off the facade for anything the helpers do not cover: `qf.jobs`, `qf.workflows`, `qf.worker`, `qf.cron`, `qf.dlq`, `qf.system`, `qf.health_api`. All of them use the tenant token except `qf.worker`, which uses `worker_token` when given.

## Jobs

| Method | Description |
| --- | --- |
| `qf.create_job(task, ...) -> Job` | Enqueue, then fetch and return the full job. Options below. |
| `qf.wait_for_job(job_id, timeout=60.0, interval=0.5) -> Job` | Poll until `completed`, `failed`, or `cancelled`. Raises `WaitTimeout`. |
| `qf.jobs.get_job(id)` | Fetch a job. |
| `qf.jobs.list_jobs(status=..., queue=..., limit=..., offset=..., order_by=..., include_total=..., cursor=..., created_after=..., created_before=...)` | List jobs. |
| `qf.jobs.cancel_job(id)` | Cancel a job. |
| `qf.jobs.create_batch_jobs(CreateBatchJobsRequest(...))` | Enqueue up to 1000 jobs at once. |

`create_job` takes the task name and these keyword options, all optional; unset fields are not sent, so the server defaults apply:

```python
qf.create_job(
    task,                        # registered task handler name
    payload=None,                # dict
    priority=None,               # higher is dequeued first
    max_retries=None,            # attempts before dead-lettering
    timeout=None,                # per-attempt timeout, seconds
    queue=None,                  # override the destination queue
    retry_backoff=None,          # "fixed", "linear", or "exponential"
    retry_delay_secs=None,       # base retry delay
    retry_max_delay_secs=None,   # cap on any computed delay
    jitter_factor=None,          # 0..=1, 0.1 = +/-10%
    idempotency_key=None,        # sent as the Idempotency-Key header
    run_at=None,                 # datetime: don't run before this instant
)
```

`idempotency_key` makes the create idempotent per tenant: re-submitting the same key returns the original job instead of creating a duplicate. `run_at` delays the first run; the job is created immediately but stays invisible to workers until then.

List responses carry `next_cursor` when there are more pages (`has_more` is true); pass it back as `cursor` for keyset pagination, which is cheaper than deep `offset`.

## Workflows

| Method | Description |
| --- | --- |
| `qf.create_workflow(builder_or_request) -> Workflow` | Create from a `wf()` builder or a raw `CreateWorkflowRequest`; returns the full workflow. |
| `qf.wait_for_workflow(workflow_id, timeout=60.0, interval=0.5) -> Workflow` | Poll until `completed`, `failed`, `partially_failed`, or `cancelled`. Raises `WaitTimeout`. |
| `qf.workflows.get_workflow(id)` / `list_workflows(...)` / `cancel_workflow(id)` | Fetch, list, cancel. |
| `qf.workflows.get_workflow_step_states(id)` | Runtime status of every step, in declaration order, with the job id executing it. |
| `qf.workflows.get_workflow_diagram(id)` | Mermaid (`graph TD`) diagram of the DAG. |

### Workflow builder

```python
from queueflow.facade import wf
from queueflow.models import JobConfig

dag = (
    wf("order_123")
    .step("validate", "validate_order", payload={"order_id": 123})
    .step("pay", "process_payment", after=["validate"], config=JobConfig(max_retries=5))
    .step("ship", "create_shipment", after=["pay"], on_failure="continue")
    .context(source="web")
)
# .build() runs locally first: duplicate names, dangling deps, and cycles raise
# WorkflowValidationError before any network round-trip.
```

`step(name, task, ...)` takes these keyword options:

| Option | Meaning |
| --- | --- |
| `after` | List of step names that must complete before this one runs. |
| `payload` | Dict passed to the task handler. |
| `on_failure` | `"halt"` (default), `"skip"`, or `"continue"`. |
| `on_success` | The step's success policy. |
| `config` | A `models.JobConfig` override for this step; the server fills defaults for any field left unset. |

`context(**kwargs)` seeds the shared workflow context and merges across calls. `qf.create_workflow` calls `build()` for you.

## Worker

`run_worker` is a complete remote worker: it leases jobs from one queue, dispatches each to a handler by task name, heartbeats while handlers run, and reports the outcome. The engine owns retries, backoff, the dead-letter queue, and workflow advancement, so a Python handler gets the same semantics as one compiled into the server.

```python
import os
import signal
import threading

from queueflow.facade import QueueFlow, NonRetryableError

qf = QueueFlow(
    "http://localhost:8000",
    os.environ["QUEUEFLOW_TOKEN"],                      # tenant token
    worker_token=os.environ["QUEUEFLOW_WORKER_TOKEN"],  # the server's --worker-token
)

def send_email(job):
    if not job.payload.get("to"):
        raise NonRetryableError("no recipient")   # dead-letters immediately
    deliver(job.payload)                          # any other exception retries per policy
    return {"sent": True}

def transcode(job, ctx):
    for chunk in chunks(job.payload):
        if ctx.cancelled:                         # lease lost, cancelled mid-run, or abandoned by the drain:
            return {}                             # stop, the server owns the outcome now
        process(chunk)
    return {"ok": True}

# Set the event (here from a signal handler) to stop: the loop exits and
# in-flight handlers get drain_timeout seconds to finish and report.
stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())

result = qf.run_worker(
    "orders",
    {"send_email": send_email, "transcode": transcode},
    stop=stop,
    concurrency=4,
)
for job in result.unfinished:                     # still running when the drain gave up
    print("abandoned", job.id)                    # nothing was reported; the server redelivers
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
    concurrency: int = 1,
    poll_wait_secs: int = 5,
    drain_timeout: float = 30.0,
) -> WorkerRunResult   # .unfinished: list[Job]
```

### Options

| Parameter | Default | Meaning |
| --- | --- | --- |
| `queue` | required | The queue to lease from. One `run_worker` call drains one queue; run several threads or processes for several queues. |
| `handlers` | required | Task name to callable. A leased job whose task name has no entry is failed with `retryable=False` and dead-lettered (`"no worker handler for task '...'"`), so it does not block the queue. |
| `lease_secs` | `30` | Lease duration per job. Every in-flight job is heartbeated at half this interval. |
| `wait_secs` | `20` | Long-poll wait when the queue is empty. |
| `stop` | `None` | A `threading.Event`. Set it to stop the loop and drain. Without it the loop runs forever. |
| `on_error` | `None` | Called with each transient lease error instead of the default throttled log line (first failure, then every 30th consecutive one). |
| `concurrency` | `1` | Handlers running at once, on a `ThreadPoolExecutor`. Each lease asks for as many jobs as there are free slots (capped at the server's 100 per call); no lease is issued while every slot is busy. Must be at least 1. |
| `poll_wait_secs` | `5` | Cap on `wait_secs` while `stop` is provided, which bounds how long a stop can take (see below). |
| `drain_timeout` | `30.0` | Seconds to wait for in-flight handlers after `stop` is set. |

### Handler contract

- A handler is called as `handler(job)` or, if it accepts two or more positional parameters, as `handler(job, ctx)`. `job` is the generated `queueflow.models.Job` (`job.id`, `job.task_name`, `job.payload`, `job.config`, and so on). `ctx` is a `WorkerContext` whose `cancelled` property flips to `True` when the server owns the outcome.
- Return a `dict` to store as the job's `result`; returning `None` stores `{}`. For a workflow step the result is merged into the workflow context.
- Raising any exception fails the attempt as **retryable**: the engine schedules a retry if budget remains, otherwise dead-letters the job with reason `max_attempts_exceeded`.
- Raising `NonRetryableError`, or any exception whose `retryable` attribute is `False`, fails the attempt as **non-retryable**: the job is dead-lettered immediately with reason `non_retryable`, regardless of remaining budget. Use it for bad input and other permanent errors.
- Delivery is at-least-once. A worker can crash after doing the work but before reporting, and the job will run again, so key side effects on `job.id` or a natural key in the payload.

### Heartbeats and cancellation

Each in-flight job is heartbeated from its own background thread every `max(1, lease_secs / 2)` seconds, extending the lease by `lease_secs`, for as long as the handler runs. A long handler never needs to think about the lease.

If a heartbeat reports that the job is no longer `running` (it was cancelled mid-run, or the lease expired and the janitor reclaimed it) or answers `409`, the server owns the outcome. The runtime sets `ctx.cancelled` to `True` and discards whatever the handler returns or raises; nothing is reported. Handlers that loop over work should check `ctx.cancelled` periodically and stop, because any further work is wasted.

If reporting an outcome fails (the server is unreachable, for example), the runtime logs a warning and does not retry the report. The lease expires and the engine redelivers the job; a reporting error is never converted into a job failure.

### Stop and drain

Set `stop`. The generated urllib3 client cannot cancel an in-flight long poll, so while `stop` is provided each lease waits at most `poll_wait_secs` (never more than `wait_secs`), which bounds stop latency to about that long; without `stop`, the full `wait_secs` is used. After the loop exits, handlers already running get up to `drain_timeout` seconds to finish and report. Any handler still running after that is abandoned: its `ctx.cancelled` flips, nothing is reported (the lease expires and the server redelivers), and the job is listed in the returned `WorkerRunResult.unfinished`. Python cannot kill a thread, so an abandoned handler keeps its pool thread until it returns; long handlers should check `ctx.cancelled`.

There is no built-in signal handling; set the event from your own `SIGTERM`/`SIGINT` handler as in the example above.

### Lease errors

A lease request that fails with `401` or `403` raises the `ApiException` after the same drain, because a wrong or missing worker token cannot heal by retrying. Any other lease error (a `5xx`, a network failure) is passed to `on_error` if given, or logged on the first failure and every thirtieth consecutive one after that, and the loop sleeps one second before trying again.

## The worker token

Worker-protocol routes (`lease`, `heartbeat`, `complete`, `fail`) authenticate with the server's **worker token**, not a tenant token, because workers execute every tenant's jobs. Pass it as `QueueFlow(base_url, token, worker_token=...)`; `run_worker` and `qf.worker` then send it on those routes while `qf.jobs`, `qf.workflows`, and the other tenant clients keep using `token`. Configure it on the server with `--worker-token` or `QUEUEFLOW_WORKER_TOKEN`.

Without `worker_token`, `qf.worker` reuses the tenant token. That only works against a server started with `--dev` (or `QUEUEFLOW_DEV=1`); a production server returns `403` and `run_worker` raises. See [Authentication and tenants](/concepts/auth#development-mode).

## Cron

| Method | Description |
| --- | --- |
| `qf.create_cron(name, schedule, task, payload=None, queue=None) -> str` | Register a recurring enqueue (5-field crontab, UTC); returns the schedule id. |
| `qf.cron.get_cron(id)` / `list_crons(...)` / `delete_cron(id)` | Fetch, list, delete. |
| `qf.cron.pause_cron(id)` / `resume_cron(id)` | Stop firings, or resume at the next future occurrence. |

## Dead letters

| Method | Description |
| --- | --- |
| `qf.dlq.list_dead_letters(...)` / `get_dead_letter(id)` | Inspect terminally failed jobs. |
| `qf.replay_dead_letter(id) -> Job` | Re-run one as a fresh job and return it. A second replay is a `409`. |

## System

```python
qf.system.get_stats()    # engine counters
qf.system.list_tasks()   # registered task handler names
qf.queues()              # live per-queue backlog
qf.health_api.get_health()
qf.health_api.get_ready()
```

`qf.queues()` (`GET /api/v1/queues`) returns a `list[QueueStats]` with one entry per queue that currently has non-terminal jobs: the claimable `pending` count, the future-dated `scheduled` count, the `running` count, and how long the oldest claimable job has waited. Use it to decide whether to add workers; idle queues are omitted. `qf.system.list_queues()` is the raw call.

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

The raw worker endpoints are on `qf.worker` (`lease_jobs`, `heartbeat_job`, `complete_job`, `fail_job`) for the rare case where `run_worker` does not fit. A hand-rolled loop must honour the same contract: heartbeat every in-flight job at about half its lease interval, stop when a heartbeat says the job is no longer `running`, and report permanent failures with `retryable=False`. See [Remote workers](/concepts/workers).

Every operation and model is listed in the package's [README](https://github.com/elision-labs/queueflow-sdk-python) and matches the [REST API reference](/api) one to one, in snake_case.

## Errors

Generated calls raise `queueflow.exceptions.ApiException` (with `.status`, `.reason`, `.body`) and its subclasses `BadRequestException` (400), `UnauthorizedException` (401), `ForbiddenException` (403), `NotFoundException` (404), and `ServiceException` (5xx) on any non-2xx response. The facade adds `WaitTimeout` (a `wait_for_*` deadline passed), `WorkflowValidationError` (a bad DAG, raised before any request), and `NonRetryableError` (raise from a handler to dead-letter immediately).

```python
from queueflow.exceptions import ApiException, NotFoundException
from queueflow.facade import WaitTimeout

try:
    job = qf.wait_for_job("missing", timeout=10)
except NotFoundException:
    ...
except WaitTimeout:
    ...
except ApiException as err:
    print(err.status, err.body)
```

## Known limitation: `stream_job_events`

`JobsApi.stream_job_events` cannot stream: it buffers the whole SSE response until the server closes it (terminal status or the 15-minute cap). Use `wait_for_job` instead, or call `stream_job_events_without_preload_content` and parse the `text/event-stream` body yourself.

## Conformance tests

`test/test_live.py` runs the facade against a real QueueFlow server started with the default `queueflow serve` (`--mode all`, so the built-in `echo` handler is registered). It creates and waits on an `echo` job, checks idempotent re-creation, runs a two-step workflow, exercises the cron and dead-letter endpoints, reads stats, and runs `run_worker` against a dedicated queue. The tests are marked `live` and skip themselves unless `QUEUEFLOW_URL` is set, so plain `pytest` and CI stay offline.

```bash
QUEUEFLOW_URL=http://localhost:8000 \
QUEUEFLOW_TOKEN=dev \
QUEUEFLOW_WORKER_TOKEN=worker-secret \
pytest -m live
```

`QUEUEFLOW_TOKEN` is the tenant token (default `dev`). `QUEUEFLOW_WORKER_TOKEN` is the server's `--worker-token`; it defaults to the tenant token, which only works when the server runs without one.
