---
title: Workflows
description: Declare a DAG of steps with dependencies, conditions, fan-out and sub-workflows. QueueFlow gates each step, threads results through a shared context, applies per-step failure policies, enforces a deadline, and can retry from failure.
---

A workflow is a directed acyclic graph (DAG) of named steps. A step runs a task (one job), a task once per element of an array (a fan-out), or an inline child workflow. Edges are declared with `depends_on`; a `when` condition can gate a step on the context. The engine schedules a step only once every step it depends on has finished, merges each result into a shared context, and derives the workflow's final status from the steps.

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
| `task_name` | unless `workflow` | The handler to run. |
| `depends_on` | no | Names of steps that must finish first. Empty or absent for root steps. |
| `payload` | no | JSON object for the handler. The engine adds `_context` to it at enqueue time. |
| `config` | no | Partial [job configuration](/concepts/jobs#job-configuration) for this step, including its per-attempt `timeout_secs` and retries. Omitted fields take the defaults. |
| `queue` | no | Queue for this step's job(s). The server's default queue when absent. Since 0.6.0. |
| `on_failure` | no | `halt` (default), `skip`, or `continue`. See [Failure policies](#failure-policies). |
| `on_success` | no | Reserved; only `continue` exists today. |
| `when` | no | A [condition](#conditional-steps) over the context; the step is skipped when it is false. Since 0.6.0. |
| `fan_out` | no | Run the task once per element of an array in the context. See [Fan-out](#fan-out). Since 0.6.0. |
| `workflow` | no | An inline child workflow to run instead of a task. See [Sub-workflows](#sub-workflows). Since 0.6.0. |
| `metadata` | no | Free-form JSON copied onto the step's job(s). |

Workflow-level `context` seeds the shared context; `metadata` is stored on the workflow for your own bookkeeping; `timeout_secs` (since 0.6.0) is the whole-workflow [deadline](#timeouts).

### Validation

The definition is validated before anything is stored. Each of these is a `400`:

- duplicate step names,
- a `depends_on` entry naming a step that does not exist,
- a cycle anywhere in the graph,
- a step `config` outside the documented limits,
- a step with neither `task_name` nor `workflow`, or with both `fan_out` and `workflow`,
- a malformed `when` condition, an invalid `queue` name, a `fan_out` without a `path`,
- a `timeout_secs` of zero or over 30 days, or sub-workflows nested more than 8 deep.

Errors name the step: `step 'charge': when: op gt needs a value`.

The SDK builders run the same structural checks locally, so a bad DAG fails before any network call.

## Scheduling

1. On creation, every step with no dependencies is scheduled immediately. The workflow becomes `running`.
2. When a step's job completes, its `result` is merged into the workflow context under the step's name. Then every step whose dependencies are now all satisfied is scheduled: its `when` condition is evaluated against the context, and the step is skipped or its job(s) or child workflow created. The merge happens before the status write, so a fan-in step can never observe a partial context.
3. Claiming a step and creating its job(s) is one atomic store operation, so two workers finishing sibling steps at the same instant cannot double-schedule a join step.
4. When no step is left to run, the workflow's final status is computed from the step states.

Step jobs run on the step's `queue`, or the server's default queue (`--default-queue`) when none is set, with `workflow_id` and `workflow_step_id` set. In-process handlers or remote workers on that queue execute them exactly like any other job, including retries and dead-lettering.

If a server crashes between finishing a step and advancing the workflow, the janitor's self-heal sweeps notice the stuck workflow, step, or child workflow and advance it.

## Conditional steps

`when` gates a step on the context at the moment it becomes ready. A leaf names a dotted `path` (step results live under their step name, so `validate.ok` is the `ok` key of the `validate` step's result; numeric segments index arrays) and compares the value there with `value` using `op`:

| `op` | True when |
| --- | --- |
| `eq` (default with a `value`) | the value at `path` equals `value` (JSON equality) |
| `ne` | it does not |
| `gt`, `gte`, `lt`, `lte` | numbers compare numerically, strings lexicographically |
| `exists` (default without a `value`) | the path resolves to something other than `null` |
| `contains` | an array at `path` contains `value`, a string contains the string `value`, or an object has the key `value` |
| `in` | the array `value` contains the value at `path` |

Leaves combine with `all`, `any` and `not`:

```json
{ "name": "manual_review", "task_name": "queue_for_review", "depends_on": ["fraud"],
  "when": { "any": [
    { "path": "fraud.score", "op": "gt", "value": 0.8 },
    { "all": [ { "path": "validate.total_cents", "op": "gte", "value": 100000 },
               { "not": { "path": "customer.trusted", "value": true } } ] }
  ] } }
```

A false condition marks the step `skipped` with the reason `condition not met`. Unlike a step skipped by a failure policy, a condition-skipped step **satisfies its dependents**: they run as normal, simply without a result for it in `_context`. A missing path never errors; it compares as absent (`exists` false, `ne` true, everything else false).

## Fan-out

A fan-out step runs its task once per element of an array in the context:

```json
{ "name": "resize", "task_name": "resize_image", "depends_on": ["fetch"],
  "fan_out": { "path": "fetch.images", "item_key": "image" },
  "config": { "max_retries": 2 }, "on_failure": "continue" }
```

When `resize` becomes ready the engine reads `fetch.images` and creates one child job per element, all in one atomic claim. Each child gets the step's payload plus the element under `item_key` (`item` by default) and its position under `_index`, with `_context` as usual; the job's metadata carries `fan_out_index` and `fan_out_total`. Children run like any other jobs, concurrently across every worker on the queue, each with its own retries.

The step settles when its last child does. If every child completed, the step completes with the result `{"results": [r0, r1, ...]}` in element order, which downstream steps read as `_context.resize.results`. If a child fails for good, the step's `on_failure` policy applies: under `halt` the failure is acted on immediately and the remaining children are cancelled; under `skip` and `continue` the other children finish first and the step then ends with an error such as `1 of 3 items failed; item 1: ...`.

An empty array completes the step at once with `{"results": []}`. A path that is missing or not an array, or more than `max_items` elements (default and ceiling 10000), fails the step under its policy before any child runs. The step's live state reports `fan_out: {total, completed, failed}`; `GET /api/v1/jobs?task_name=resize_image` lists the children.

## Sub-workflows

A step can run an inline child workflow instead of a task:

```json
{ "name": "fulfil", "depends_on": ["charge"], "payload": { "warehouse": "eu-1" },
  "workflow": { "name": "fulfilment", "timeout_secs": 1800, "steps": [
    { "name": "pick", "task_name": "pick_items" },
    { "name": "pack", "task_name": "pack_parcel", "depends_on": ["pick"] },
    { "name": "label", "task_name": "print_label", "depends_on": ["pack"] }
  ] } }
```

When `fulfil` becomes ready the child is created as a workflow of its own, in the same tenant, with `parent_workflow_id` and `parent_step_name` set. Its context is the child's declared `context`, then the step's `payload`, then the parent's whole context under `_parent`, so child steps read parent results as `_context._parent.charge`. The child shows up in `GET /api/v1/workflows` and the dashboard like any other workflow; the parent's step state carries its `child_workflow_id`.

The step settles when the child does: a completed child completes the step with the child's final context as the step result (`_context.fulfil.label` downstream); a failed, partially failed or cancelled child fails the step under its `on_failure` policy, with the child's error in the step's error. Cancelling or timing out the parent cancels a running child. Children nest up to 8 levels.

## Timeouts

Each step's job has a per-attempt `timeout_secs` in its `config`. A workflow can also carry a whole-workflow budget: `"timeout_secs": 3600` on the request sets `deadline_at` an hour after creation. If the workflow is still running when the janitor finds the deadline passed, every unfinished step is cancelled (their jobs and child workflows too) and the workflow ends `failed` with the error `workflow timed out after 3600s`. A retry re-arms the deadline from the original timeout.

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
| `halt` (default) | `failed` | Every step not yet finished is `cancelled`, child workflows included. | `failed`, with the step's error as the workflow's `error_message` |
| `skip` | `skipped` | The step's transitive dependents are `skipped`; unrelated branches keep running. | `partially_failed` if everything else completes |
| `continue` | `failed` | Dependents are still scheduled and run as normal. | `partially_failed` if everything else completes |

The same policy decides what a failed fan-out child or a failed child workflow does to the step.

The Ship-It demo uses all three on purpose: a fraud rejection halts the order, a bounced confirmation email is skipped so the parcel still ships, and the warehouse hand-off continues regardless.

## Statuses

Workflow status is one of:

| Status | Meaning |
| --- | --- |
| `created` | Stored; no step has run yet. |
| `running` | At least one step is pending or running. |
| `completed` | Every step completed. |
| `partially_failed` | Finished, with at least one `failed` or `skipped` step under a `skip` or `continue` policy. |
| `failed` | A step with `on_failure: halt` failed, every step failed, or the deadline passed. `error_message` says which. |
| `cancelled` | Cancelled through the API, or because the parent workflow ended. |

Step status is one of `pending`, `running`, `completed`, `failed`, `cancelled`, `skipped`. Steps skipped by their condition count as successes when the workflow's status is computed; steps skipped by a failure policy do not.

## Inspecting a workflow

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/workflows/{id}` | The workflow record: name, status, timestamps, `error_message`, `timeout_secs` and `deadline_at`, `retry_count`, parent linkage, accumulated `context`, `metadata`, and the step **definitions**. |
| `GET /api/v1/workflows/{id}/steps` | The live progress view: one `{name, status, job_id, error, started_at, completed_at, child_workflow_id, fan_out}` per step, in declaration order. |
| `GET /api/v1/workflows/{id}/events` | Server-Sent Events: a `status` event with the workflow status and every step's state whenever any of them changes, until the workflow is terminal (since 0.6.0). |
| `GET /api/v1/workflows/{id}/diagram` | `{"format": "mermaid", "diagram": "graph TD …"}`, ready to render. Fan-out steps are hexagons, sub-workflow steps subroutine boxes. |
| `GET /api/v1/workflows` | List with the same paging and time-range parameters as jobs, plus `status`. |

Each step state's `job_id` leads to the step's job (the first child, for a fan-out), where you can read its `result`, `error_message`, `retry_count`, and so on, or stream its events. `started_at` is when the step was scheduled and `completed_at` when it reached a terminal status.

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

## Cancelling and retrying

`POST /api/v1/workflows/{id}/cancel` marks the workflow `cancelled` and cancels every step that has not yet finished, including fan-out children still running and any child workflow. A step that is currently running is cancelled like any running job: its worker sees a non-`running` status at the next heartbeat and should stop.

`POST /api/v1/workflows/{id}/retry` (since 0.6.0) re-runs a `failed`, `partially_failed` or `cancelled` workflow from where it stopped: every step that did not complete (failed, cancelled, or skipped by a policy) goes back to `pending` with a clean slate and is scheduled again as its dependencies allow; completed steps and condition-skipped steps keep their state and results and do not run again. The workflow becomes `running`, its `error_message` clears, `retry_count` increments, and the deadline, if any, is re-armed from the original `timeout_secs`. Retrying a running or completed workflow is a `409`. Fix the cause first (a handler bug, a missing worker); a retry with the same inputs fails the same way.

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

- Fan-out elements are read from the context once, when the step becomes ready; a fan-out cannot grow while running.
- A step's `when` is evaluated once, when it becomes ready, not re-evaluated later.
- A retry re-runs failed steps with their original definitions; the definition of a stored workflow cannot be edited.
