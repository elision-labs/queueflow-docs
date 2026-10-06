---
title: Workflows
description: Declare a DAG of steps with dependencies. QueueFlow gates each step on its dependencies, threads results through a shared context, and applies per-step failure policies.
---

A workflow is a directed acyclic graph (DAG) of named steps. Each step is a job: a task name, a payload, and an optional per-step config. Edges are declared with `depends_on`. The engine enqueues a step only once every step it depends on has completed, merges each result into a shared context, and derives the workflow's final status from the steps.

## Defining a workflow

```json
{
  "name": "order_123",
  "context": { "source": "web" },
  "metadata": { "app": "shop" },
  "steps": [
    { "name": "validate", "task_name": "validate_order", "payload": { "order_id": 123 } },
    { "name": "charge",   "task_name": "charge_payment", "depends_on": ["validate"],
      "config": { "max_retries": 4, "retry_delay_secs": 2, "jitter_factor": 0.2 } },
    { "name": "fraud",    "task_name": "fraud_check",    "depends_on": ["validate"], "on_failure": "halt" },
    { "name": "reserve",  "task_name": "reserve_stock",  "depends_on": ["charge", "fraud"] },
    { "name": "confirm",  "task_name": "send_confirmation", "depends_on": ["reserve"], "on_failure": "skip" },
    { "name": "ship",     "task_name": "notify_warehouse",  "depends_on": ["reserve"], "on_failure": "continue" }
  ]
}
```

```bash
curl -s -X POST http://localhost:8000/api/v1/workflows \
  -H 'Authorization: Bearer <tenant-token>' -H 'Content-Type: application/json' \
  -d @order.json
# 201 {"workflow_id":"9a7e…"}
```

| Step field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique within the workflow. Steps are addressed by name everywhere: `depends_on`, the context, step states, and the job's `workflow_step_id`. |
| `task_name` | yes | The handler to run. |
| `depends_on` | no | Names of steps that must complete first. Empty or absent for root steps. |
| `payload` | no | JSON object for the handler. The engine adds `_context` to it at enqueue time. |
| `config` | no | Partial [job configuration](/concepts/jobs#job-configuration) for this step. Omitted fields take the defaults. |
| `on_failure` | no | `halt` (default), `skip`, or `continue`. See [Failure policies](#failure-policies). |
| `on_success` | no | Reserved; only `continue` exists today. |
| `metadata` | no | Free-form JSON copied onto the step's job. |

Workflow-level `context` seeds the shared context; `metadata` is stored on the workflow for your own bookkeeping.

### Validation

The definition is validated before anything is stored. Each of these is a `400`:

- duplicate step names,
- a `depends_on` entry naming a step that does not exist,
- a cycle anywhere in the graph,
- a step `config` outside the documented limits.

The SDK builders run the same structural checks locally, so a bad DAG fails before any network call.

## Scheduling

1. On creation, every step with no dependencies is enqueued immediately. The workflow becomes `running`.
2. When a step's job completes, its `result` is merged into the workflow context under the step's name. Then every step whose dependencies are now all complete is enqueued. The merge happens before the status write, so a fan-in step can never observe a partial context.
3. Claiming a step and creating its job is one atomic store operation, so two workers finishing sibling steps at the same instant cannot double-schedule a join step.
4. When no step is left to run, the workflow's final status is computed from the step states.

Step jobs always run on the server's default queue (`--default-queue`), with `workflow_id` and `workflow_step_id` set. In-process handlers or remote workers on that queue execute them exactly like any other job, including retries and dead-lettering. A step that needs work done on another queue can enqueue a regular job from its handler.

If a server crashes between finishing a step and advancing the workflow, the janitor's self-heal sweep notices the stuck workflow and advances it.

## Context propagation

The workflow `context` is a JSON object keyed by step name. When a step is enqueued, the current context is injected into its payload under `_context`:

```json
{
  "order_id": 123,
  "_context": {
    "source": "web",
    "validate": { "ok": true, "total_cents": 4200 },
    "charge":   { "charge_id": "ch_1" },
    "fraud":    { "score": 0.02 }
  }
}
```

A handler reads its upstream results from `_context` and returns its own result object, which becomes `_context.<step name>` for everything downstream. Return small, serializable summaries rather than large blobs: the whole context is copied into every downstream payload.

## Failure policies

`on_failure` says what happens to the rest of the graph when a step's job ends `failed` (after exhausting its own retries, or on a non-retryable error).

| Policy | Effect on the failed step | Effect on dependents | Workflow result |
| --- | --- | --- | --- |
| `halt` (default) | `failed` | Every step not yet finished is `cancelled`. | `failed` |
| `skip` | `failed` | The step's transitive dependents are `skipped`; unrelated branches keep running. | `partially_failed` if everything else completes |
| `continue` | `failed` | Dependents are still scheduled and run as normal. | `partially_failed` if everything else completes |

The Ship-It demo uses all three on purpose: a fraud rejection halts the order, a bounced confirmation email is skipped so the parcel still ships, and the warehouse hand-off continues regardless.

## Statuses

Workflow status is one of:

| Status | Meaning |
| --- | --- |
| `created` | Stored; no step has run yet. |
| `running` | At least one step is pending or running. |
| `completed` | Every step completed. |
| `partially_failed` | Finished, with at least one `failed` or `skipped` step under a `skip` or `continue` policy. |
| `failed` | A step with `on_failure: halt` failed, or the workflow could not proceed. |
| `cancelled` | Cancelled through the API. |

Step status is one of `pending`, `running`, `completed`, `failed`, `cancelled`, `skipped`.

## Inspecting a workflow

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/workflows/{id}` | The workflow record: name, status, timestamps, accumulated `context`, `metadata`, and the step **definitions**. |
| `GET /api/v1/workflows/{id}/steps` | The live progress view: one `{name, status, job_id}` per step, in declaration order. |
| `GET /api/v1/workflows/{id}/diagram` | `{"format": "mermaid", "diagram": "graph TD …"}`, ready to render. |
| `GET /api/v1/workflows` | List with the same paging and time-range parameters as jobs, plus `status`. |

Each step state's `job_id` leads to the step's job, where you can read its `result`, `error_message`, `retry_count`, and so on, or stream its events.

```text
graph TD
    validate["validate"]
    charge["charge"]
    fraud["fraud"]
    reserve["reserve"]
    confirm["confirm"]
    ship["ship"]
    validate --> charge
    validate --> fraud
    charge --> reserve
    fraud --> reserve
    reserve --> confirm
    reserve --> ship
```

## Cancelling

`POST /api/v1/workflows/{id}/cancel` marks the workflow `cancelled` and cancels every step that has not yet finished. A step that is currently running is cancelled like any running job: its worker sees a non-`running` status at the next heartbeat and should stop.

## Builders in the SDKs

Every SDK ships a builder that produces the same `CreateWorkflowRequest` JSON and validates it locally first:

```ts
import { wf } from "@queueflow/sdk";

const dag = wf("order_123")
  .step("validate", "validate_order", { payload: { order_id: 123 } })
  .step("charge", "charge_payment", { after: ["validate"], config: { max_retries: 4, retry_delay_secs: 2 } })
  .step("fraud", "fraud_check", { after: ["validate"], onFailure: "halt" })
  .step("reserve", "reserve_stock", { after: ["charge", "fraud"] })
  .step("confirm", "send_confirmation", { after: ["reserve"], onFailure: "skip" })
  .step("ship", "notify_warehouse", { after: ["reserve"], onFailure: "continue" })
  .context({ source: "web" });

const run = await qf.workflows.create(dag);
const finished = await qf.workflows.waitFor(run.id);
console.log(finished.status, finished.context);
```

See the [TypeScript](/sdks/typescript), [Python](/sdks/python), [Go](/sdks/go), and [Rust](/sdks/rust) pages for the equivalent builders, and the [CLI](/cli) for `queueflow workflow create --file`.

## Current limits

Conditional steps (a predicate evaluated before scheduling), sub-workflows, and dynamic fan-out are on the [roadmap](https://github.com/elision-labs/queueflow-core#roadmap) but not yet available. Today a step can emulate fan-out by enqueuing regular jobs from its handler.
