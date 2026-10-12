---
title: Go SDK
description: The queueflow-sdk-go module. A Go client generated from the OpenAPI spec with a facade for jobs, workflows, cron, dead letters, queue backlog, typed errors, and a concurrent worker runtime with graceful stop.
---

The Go SDK is generated from the server's OpenAPI spec with openapi-generator, with a hand-written facade (`facade.go`) injected at generation time so it is regenerated alongside the core and cannot drift. The facade is the recommended entry point: one method per endpoint on `QueueFlow`, `WaitForJob` and `WaitForWorkflow` pollers, a workflow builder with local DAG validation, `*APIError` for every non-2xx response, and `Run`, a worker runtime that leases jobs, runs your handlers concurrently, heartbeats them, and reports outcomes. The generated `APIClient` and its `*APIService` groups remain available for everything else.

- **Requires** Go 1.18 or newer. Module path `github.com/elision-labs/queueflow-sdk-go`, package `queueflow`.
- **Source**: [elision-labs/queueflow-sdk-go](https://github.com/elision-labs/queueflow-sdk-go), version 0.5.0 (tag `v0.5.0`).

## Install

```bash
go get github.com/elision-labs/queueflow-sdk-go@v0.5.0
```

```go
import queueflow "github.com/elision-labs/queueflow-sdk-go"
```

## Quick start

```go
package main

import (
	"context"
	"log"

	queueflow "github.com/elision-labs/queueflow-sdk-go"
)

func main() {
	ctx := context.Background()
	qf := queueflow.NewQueueFlow("http://localhost:8000", "dev")

	// Enqueue a job and wait for the result.
	id, err := qf.CreateJob(ctx, "echo", map[string]interface{}{"hello": "world"})
	if err != nil {
		log.Fatal(err)
	}
	done, err := qf.WaitForJob(ctx, id, queueflow.WaitOptions{})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(done.Status, done.Result) // completed map[echoed:true hello:world]

	// Declare and run a DAG workflow.
	dag := queueflow.NewWorkflowBuilder("etl").
		Step("extract", "echo").
		Step("transform", "echo", "extract").
		Step("load", "echo", "transform")
	wfID, err := qf.CreateWorkflow(ctx, dag)
	if err != nil {
		log.Fatal(err)
	}
	finished, err := qf.WaitForWorkflow(ctx, wfID, queueflow.WaitOptions{})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(finished.Status)
}
```

`echo` is a handler built into the server; it returns the payload plus `"echoed": true`. The `"dev"` token only works against a server started with `--dev`; see [Authentication and tenants](/concepts/auth).

## Client

```go
qf := queueflow.NewQueueFlow(baseURL, token)

// or, with a separate worker token and a custom timeout:
qf, err := queueflow.NewQueueFlowWithOptions(queueflow.Options{
	BaseURL:     "http://localhost:8000",
	Token:       "dev",            // tenant token (required)
	WorkerToken: "worker-secret",  // for LeaseJobs/HeartbeatJob/CompleteJob/FailJob and Run (default: Token)
	Timeout:     30 * time.Second, // per-request HTTP timeout (default 30s)
	HTTPClient:  nil,              // optional base *http.Client (transport, proxies)
})
```

Every method takes a `context.Context` first. The per-request timeout applies to every call except the lease long-poll, which is bounded by `wait_secs + 35s` instead. `NewQueueFlowWithOptions` returns an error when `BaseURL` or `Token` is empty.

| Field | Description |
| --- | --- |
| `qf.Client` | The generated `*APIClient` with the tenant token (`.JobsAPI`, `.WorkflowsAPI`, `.CronAPI`, `.DlqAPI`, `.SystemAPI`, `.HealthAPI`). |
| `qf.WorkerClient` | The generated `*APIClient` with the worker token (`.WorkerAPI`). |

## Jobs

| Method | Description |
| --- | --- |
| `CreateJob(ctx, task, payload) (string, error)` | Enqueue with the server defaults; returns the job id. |
| `CreateJobWithOptions(ctx, task, CreateJobOptions) (string, error)` | Enqueue with config, idempotency key, and `RunAt`; returns the job id. |
| `GetJob(ctx, id) (*Job, error)` | Fetch a job. |
| `ListJobs(ctx, ListOptions) (*ListJobsResponse, error)` | List jobs (`Status`, `Queue`, `Limit`, `Offset`, `OrderBy`, `IncludeTotal`, `Cursor`, `CreatedAfter`, `CreatedBefore`). |
| `CancelJob(ctx, id) error` | Cancel a job. |
| `WaitForJob(ctx, id, WaitOptions) (*Job, error)` | Poll until `completed`, `failed`, or `cancelled`. |

`CreateJobOptions` carries everything the create request accepts. Nil pointers and empty strings are not sent, so the server defaults apply:

```go
id, err := qf.CreateJobWithOptions(ctx, "send-email", queueflow.CreateJobOptions{
	Payload:           map[string]interface{}{"to": "ada@example.com"},
	Queue:             "emails",                      // override the destination queue
	Priority:          queueflow.PtrInt32(5),         // higher is claimed first
	MaxRetries:        queueflow.PtrInt32(3),         // attempts before dead-lettering
	Timeout:           queueflow.PtrInt64(30),        // per-attempt timeout, seconds
	RetryBackoff:      queueflow.BACKOFFSTRATEGY_EXPONENTIAL,
	RetryDelaySecs:    queueflow.PtrInt64(10),        // base retry delay
	RetryMaxDelaySecs: queueflow.PtrInt64(600),       // cap on any computed delay
	JitterFactor:      queueflow.PtrFloat64(0.1),     // 0..=1, 0.1 = +/-10%
	IdempotencyKey:    "signup-42",                   // sent as the Idempotency-Key header
	RunAt:             queueflow.PtrTime(time.Now().Add(time.Hour)),
})
```

Pointer fields use the generated helpers (`PtrInt32`, `PtrInt64`, `PtrFloat64`, `PtrTime`). The same `IdempotencyKey` returns the original job id. `RunAt` delays the first run; the job is created immediately but stays invisible to workers until then.

`WaitOptions` is `{Timeout, Interval time.Duration}`; the zero value means 60s and 500ms. Past the deadline the error wraps `queueflow.ErrTimeout`; a cancelled context returns `ctx.Err()`.

List responses carry `NextCursor` when there are more pages; pass it back as `Cursor` for keyset pagination, which is cheaper than deep `Offset`.

## Workflows

| Method | Description |
| --- | --- |
| `CreateWorkflow(ctx, *WorkflowBuilder) (string, error)` | Validate the DAG locally, create it, return the workflow id. |
| `GetWorkflow(ctx, id)` / `ListWorkflows(ctx, ListOptions)` / `CancelWorkflow(ctx, id)` | Fetch, list, cancel. |
| `WorkflowDiagram(ctx, id) (*WorkflowDiagramResponse, error)` | Mermaid (`graph TD`) diagram of the DAG. |
| `WorkflowSteps(ctx, id) ([]WorkflowStepState, error)` | Runtime status of every step, with the job id executing it. |
| `WaitForWorkflow(ctx, id, WaitOptions) (*Workflow, error)` | Poll until `completed`, `failed`, `partially_failed`, or `cancelled`. |

### Workflow builder

```go
dag := queueflow.NewWorkflowBuilder("order_123").
	Step("validate", "validate_order").
	StepWithOptions("pay", "process_payment", queueflow.StepOptions{
		After:     []string{"validate"},
		Payload:   map[string]interface{}{"amount": 42},
		OnFailure: queueflow.ONFAILURE_HALT,
		Config:    &queueflow.JobConfig{MaxRetries: queueflow.PtrInt32(5)},
	}).
	Step("ship", "create_shipment", "pay").
	Context(map[string]interface{}{"source": "web"})
body, err := dag.Build() // duplicate names, dangling deps, and cycles fail here, before any request
```

`Step(name, task string, after ...string)` adds a step gated on the named `after` steps. `StepWithOptions(name, task, StepOptions)` takes:

| Field | Meaning |
| --- | --- |
| `After` | Names of the steps that must complete before this one runs. |
| `Payload` | Passed to the task handler. |
| `Config` | A `*JobConfig` override for this step (retries, timeout, priority, and so on). |
| `OnFailure` | `ONFAILURE_HALT` (default), `ONFAILURE_SKIP`, or `ONFAILURE_CONTINUE`. |
| `OnSuccess` | The step's success policy. |
| `Metadata` | Free-form JSON attached to the step. |

`Context` and `Metadata` seed the workflow-level fields and merge across calls. `CreateWorkflow` calls `Build()` for you.

## Worker

`Run` is a complete remote worker: it leases jobs from one queue, dispatches each to a handler by task name in its own goroutine, heartbeats while handlers run, and reports the outcome. The engine owns retries, backoff, the dead-letter queue, and workflow advancement, so a Go handler gets the same semantics as one compiled into the server.

```go
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"time"

	queueflow "github.com/elision-labs/queueflow-sdk-go"
)

func main() {
	qf, err := queueflow.NewQueueFlowWithOptions(queueflow.Options{
		BaseURL:     "http://localhost:8000",
		Token:       os.Getenv("QUEUEFLOW_TOKEN"),        // tenant token
		WorkerToken: os.Getenv("QUEUEFLOW_WORKER_TOKEN"), // the server's --worker-token
	})
	if err != nil {
		log.Fatal(err)
	}

	handlers := map[string]queueflow.Handler{
		"send-email": func(ctx context.Context, job *queueflow.Job) (map[string]interface{}, error) {
			if job.Payload["to"] == nil {
				// Dead-letters immediately instead of burning retries.
				return nil, queueflow.NonRetryable(errors.New("no recipient"))
			}
			if err := sendEmail(ctx, job.Payload); err != nil {
				return nil, err // retryable: the server applies the job's retry policy
			}
			return map[string]interface{}{"sent": true}, nil
		},
		"transcode": func(ctx context.Context, job *queueflow.Job) (map[string]interface{}, error) {
			// ctx is cancelled if the lease is lost (cancelled mid-run or
			// reclaimed) and when the drain timeout passes after a stop.
			for _, chunk := range chunks(job.Payload) {
				if ctx.Err() != nil {
					return nil, ctx.Err() // the server owns the outcome now
				}
				process(chunk)
			}
			return map[string]interface{}{"ok": true}, nil
		},
	}

	// Cancelling ctx stops the worker: the in-flight long poll is abandoned
	// at once and running handlers get DrainTimeout to finish and report.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := qf.Run(ctx, "orders", handlers, queueflow.WorkerOptions{
		Concurrency:  4,
		DrainTimeout: 30 * time.Second,
	}); err != nil {
		log.Fatal(err) // a 401/403 from the lease call: wrong or missing worker token
	}
}
```

### Signature

```go
func (q *QueueFlow) Run(ctx context.Context, queue string, handlers map[string]Handler, opts WorkerOptions) error

type Handler func(ctx context.Context, job *Job) (map[string]interface{}, error)
```

### Options

Zero values take the defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `Concurrency` | `1` | Jobs in flight at once. Each lease call asks for as many jobs as there are free slots; no lease is issued while every slot is busy. |
| `LeaseSecs` | `30` | Lease duration per job. Every in-flight job is heartbeated at half this interval. |
| `WaitSecs` | `20` | Server-side long poll when the queue is empty (the server accepts up to 30). |
| `DrainTimeout` | `30s` | How long `Run` waits for in-flight handlers after `ctx` is cancelled. Past it their contexts are cancelled and `Run` returns. |
| `OnError` | `nil` | Called with every transient lease failure instead of the default throttled log line (first failure, then every 30th). |
| `Logf` | `log.Printf` | Receives the worker's diagnostics. |

### Handler contract

- A handler receives a per-job `context.Context` and the leased `*Job` (`job.Id`, `job.TaskName`, `job.Payload`, `job.Config`, and so on).
- Return a `map[string]interface{}` to store as the job's `result`; `nil` stores `{}`. For a workflow step the result is merged into the workflow context.
- Returning any error fails the attempt as **retryable**: the engine schedules a retry if budget remains, otherwise dead-letters the job with reason `max_attempts_exceeded`. A panicking handler is recovered and reported the same way, so one bad job cannot take the worker down.
- Returning `queueflow.NonRetryable(err)`, or any error that wraps a `*NonRetryableError`, fails the attempt as **non-retryable**: the job is dead-lettered immediately with reason `non_retryable`. Use it for bad input and other permanent errors.
- A leased job whose task has no handler is failed non-retryably, so it does not block the queue.
- Delivery is at-least-once. Key side effects on `job.Id` or a natural key in the payload.

### Heartbeats and cancellation

Each in-flight job is heartbeated every `LeaseSecs / 2` seconds, extending the lease by `LeaseSecs`, for as long as the handler runs. If a heartbeat reports that the job is no longer `running` (cancelled mid-run, or the lease expired and was reclaimed) or answers `409`, the server owns the outcome: the runtime cancels the handler's context and suppresses the report. Handlers that loop over work should check `ctx.Err()` and stop.

If reporting an outcome fails (the server is unreachable, for example), the runtime logs it and does not retry the report. The lease expires and the engine redelivers the job; a reporting error is never converted into a job failure.

### Stop and drain

Cancel the `ctx` passed to `Run`. The in-flight lease long-poll is abandoned immediately, so stopping never waits out `WaitSecs`. Handlers already running get up to `DrainTimeout` to finish and report; they run under their own context, so a stop does not cut them off before the drain window has passed. Past the deadline the runtime cancels their contexts and `Run` returns `nil`; a handler cut off by the drain is left unreported, so its lease expires and the server redelivers it rather than burning a retry on your own shutdown.

### Lease errors

`Run` returns the `*APIError` when the lease call is rejected with `401` or `403`, after the same drain, because a wrong or missing `WorkerToken` cannot heal by retrying. Any other lease error (a `5xx`, a network failure) goes to `OnError`, or to the default throttled log line, and the loop backs off one second before trying again.

### The raw protocol

The lower-level calls are also exposed, authenticated with the worker token: `LeaseJobs(ctx, queue, LeaseOptions{MaxJobs, LeaseSecs, WaitSecs})`, `HeartbeatJob(ctx, lease, extendSecs)`, `CompleteJob(ctx, lease, result)`, `FailJob(ctx, lease, message, retryable)`. A hand-rolled loop must honour the same contract as `Run`; see [Remote workers](/concepts/workers).

## Cron

| Method | Description |
| --- | --- |
| `CreateCron(ctx, name, cronExpr, task, payload) (string, error)` | Register a recurring enqueue (5-field crontab, UTC); returns the schedule id. |
| `CreateCronWithOptions(ctx, name, cronExpr, task, CreateCronOptions) (string, error)` | Also set `Queue` and a `Config` override (`CreateCronOptions{Payload, Queue, Config}`). |
| `GetCron(ctx, id)` / `ListCrons(ctx, ListOptions)` / `DeleteCron(ctx, id)` | Fetch, list, delete. |
| `PauseCron(ctx, id)` / `ResumeCron(ctx, id)` | Stop firings, or resume at the next future occurrence. |

## Dead letters

| Method | Description |
| --- | --- |
| `ListDeadLetters(ctx, ListOptions)` / `GetDeadLetter(ctx, id int64)` | Inspect terminally failed jobs. |
| `ReplayDeadLetter(ctx, id int64) (string, error)` | Re-run one as a fresh job; returns the new job id. A second replay is a `409`. |

## System

| Method | Description |
| --- | --- |
| `Stats(ctx) (*StatsSnapshot, error)` | Engine counters. |
| `Queues(ctx) ([]QueueStats, error)` | Live per-queue backlog: `Pending`, `Scheduled`, `Running`, `OldestPendingAgeSecs`. |
| `Tasks(ctx) ([]string, error)` | Registered task handler names. |
| `Health(ctx)` / `Ready(ctx)` | `GET /health` and `GET /ready`. |

`Queues` (`GET /api/v1/queues`) returns one entry per queue that currently has non-terminal jobs, so you can decide whether to add workers; idle queues are omitted.

## Everything else: the generated client

Anything the facade does not wrap (batch enqueue, raw request bodies) is one call away on `qf.Client`. Every operation is a request builder ending in `.Execute()`, which returns `(result, *http.Response, error)`:

```go
batch, _, err := qf.Client.JobsAPI.CreateBatchJobs(ctx).
	CreateBatchJobsRequest(queueflow.CreateBatchJobsRequest{Jobs: reqs}).
	Execute()
```

Every operation and model is listed in the repository's [`docs/`](https://github.com/elision-labs/queueflow-sdk-go/tree/main/docs) and matches the [REST API reference](/api) one to one, in PascalCase.

## Errors

Facade methods return `*APIError` for non-2xx responses, with the status and body attached; transport failures and context cancellation are returned unwrapped.

```go
job, err := qf.GetJob(ctx, id)
if err != nil {
	var apiErr *queueflow.APIError
	switch {
	case errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound:
		// no such job
	case errors.As(err, &apiErr):
		log.Printf("%s failed: HTTP %d: %s", apiErr.Op, apiErr.Status, apiErr.Body)
	case errors.Is(err, context.Canceled):
		// caller gave up
	default:
		return err // connection refused, timeout, decode error
	}
}
```

| Error | When |
| --- | --- |
| `*APIError` (`Op`, `Status`, `Body`, `Err`) | Any non-2xx response. `queueflow.StatusCode(err)` returns the status of an `*APIError` anywhere in the chain, or 0. |
| `ErrTimeout` | Wrapped by `WaitForJob` and `WaitForWorkflow` past their deadline; test with `errors.Is`. |
| `ctx.Err()` | The caller's context was cancelled or expired. |
| A plain error from `Build()` or `CreateWorkflow` | A structurally invalid DAG, before any request is made. |
| `*NonRetryableError` | Return `queueflow.NonRetryable(err)` from a handler to dead-letter the job immediately. |

## Known limitation: `StreamJobEvents`

`JobsAPI.StreamJobEvents` cannot consume the server's SSE stream: it buffers the whole response until the stream closes (terminal status or the 15-minute cap) and returns it as one string. Use `WaitForJob` instead, or read `GET /api/v1/jobs/{id}/events` with `net/http` and parse the `text/event-stream` body yourself.

## Conformance tests

`live_test.go` runs the facade against a real QueueFlow server started with the default `queueflow serve` (`--mode all`, so the built-in `echo` handler is registered). It creates and waits on an `echo` job, checks idempotent re-creation and list filters, runs a two-step workflow, exercises the cron, dead-letter, queue backlog, and stats endpoints, and runs `Run` against a dedicated queue: one scenario completes a job with a handler only the test knows, another dead-letters a job with `NonRetryable` and replays it. The tests skip themselves unless `QUEUEFLOW_URL` is set, so plain `go test ./...` and CI stay offline.

```bash
QUEUEFLOW_URL=http://localhost:8000 \
QUEUEFLOW_TOKEN=dev \
QUEUEFLOW_WORKER_TOKEN=worker-secret \
go test -count=1 -run Live ./...
```

`QUEUEFLOW_TOKEN` is the tenant token (default `dev`). `QUEUEFLOW_WORKER_TOKEN` is the server's `--worker-token`; it defaults to the tenant token, which only works when the server runs without one.
