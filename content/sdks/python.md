---
title: Python SDK
description: The queueflow package on PyPI. A generated client for every endpoint plus a small facade with create, wait_for, and a workflow builder.
---

The `queueflow` package is generated from the server's OpenAPI spec with openapi-generator, with a hand-written facade injected at generation time so it is regenerated alongside the core and cannot drift. The facade is the recommended entry point; the generated `queueflow.api.*` clients and `queueflow.models.*` types remain available for everything else.

- **Requires** Python 3.8 or newer. Depends on `urllib3`, `pydantic` 2, `python-dateutil`, and `typing-extensions`.
- **Source**: [elision-labs/queueflow-sdk-python](https://github.com/elision-labs/queueflow-sdk-python). **Package**: [PyPI](https://pypi.org/project/queueflow/), version 0.1.0.

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

## The facade

`QueueFlow(base_url, token, worker_token=None)` exposes:

| Member | Description |
| --- | --- |
| `create_job(task, payload=None, priority=None, max_retries=None, timeout=None, queue=None, idempotency_key=None) -> Job` | Enqueue, then fetch and return the full job. |
| `wait_for_job(job_id, timeout=60.0, interval=0.5) -> Job` | Poll until `completed`, `failed`, or `cancelled`. Raises `WaitTimeout`. |
| `create_workflow(builder_or_request) -> Workflow` | Create from a `wf()` builder or a `CreateWorkflowRequest`. |
| `wait_for_workflow(workflow_id, timeout=60.0, interval=0.5) -> Workflow` | Poll until a terminal workflow status. Raises `WaitTimeout`. |
| `.jobs`, `.workflows`, `.cron`, `.dlq`, `.system` | The generated `JobsApi`, `WorkflowsApi`, `CronApi`, `DlqApi`, and `SystemApi` clients, authenticated with the tenant token. |
| `.worker` | The generated `WorkerApi`, authenticated with `worker_token` when given. |

`wf(name)` returns a `WorkflowBuilder` whose `.step(name, task_name, after=None, payload=None, config=None, on_failure=None)` adds steps and whose `.build()` validates locally (duplicate names, dangling dependencies, cycles), raising `WorkflowValidationError` before any network round-trip.

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

Every operation and model is listed in the package's [README](https://github.com/elision-labs/queueflow-sdk-python#documentation-for-api-endpoints) and matches the [REST API reference](/api) one to one, in snake_case.

## Errors

Generated calls raise `queueflow.rest.ApiException` (also importable as `queueflow.ApiException`) with `.status`, `.reason`, and `.body` on any non-2xx response. The facade adds `WaitTimeout` for exhausted waits and `WorkflowValidationError` for a bad builder.

```python
from queueflow import ApiException

try:
    qf.jobs.get_job("missing")
except ApiException as e:
    if e.status == 404:
        ...
```

## Worker protocol

No worker runtime ships with this SDK; `qf.worker` exposes the raw endpoints (`lease_jobs`, `heartbeat_job`, `complete_job`, `fail_job`). The Ship-It demo's [Python worker](https://github.com/elision-labs/queueflow-shipit-demo/blob/main/worker-py/worker.py) is a complete, idiomatic loop built on them. Three rules keep the at-least-once contract honest:

1. Worker routes authenticate with the **worker token**, not a tenant token. Pass it as `QueueFlow(base_url, token, worker_token=...)` and `qf.worker` will use it. Without it, `qf.worker` reuses the tenant token, which only works in the server's development mode.
2. Heartbeat every in-flight job at roughly half its lease interval. A heartbeat whose `status` is anything other than `running` (or an HTTP 409) means the server owns the outcome: abandon the handler and report nothing. Never process a leased batch sequentially without heartbeating the jobs still waiting; their leases expire and the server redelivers them.
3. Delivery is at-least-once, so handlers must be idempotent. Report permanent failures with `retryable=False` so they dead-letter immediately instead of burning retries.

```python
from queueflow.models import LeaseJobsRequest, HeartbeatRequest, CompleteJobRequest, FailJobRequest

qf = QueueFlow(BASE_URL, TENANT_TOKEN, worker_token=WORKER_TOKEN)

while True:
    leased = qf.worker.lease_jobs("warehouse", LeaseJobsRequest(max_jobs=1, lease_secs=60, wait_secs=20))
    for item in leased.jobs:
        job, token = item.job, item.lease_token
        try:
            result = pack_order(job.payload)       # heartbeat from a thread/timer while this runs
            qf.worker.complete_job(job.id, CompleteJobRequest(lease_token=token, result=result))
        except PermanentError as e:
            qf.worker.fail_job(job.id, FailJobRequest(lease_token=token, error=str(e), retryable=False))
        except Exception as e:
            qf.worker.fail_job(job.id, FailJobRequest(lease_token=token, error=str(e), retryable=True))
```

## Known limitation: `stream_job_events`

`JobsApi.stream_job_events` cannot stream: it buffers the whole SSE response until the server closes it (terminal status or the 15-minute cap). Use `wait_for_job` instead, or call `stream_job_events_without_preload_content` and parse the `text/event-stream` body yourself.
