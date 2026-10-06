---
title: Go SDK
description: A Go client generated from the OpenAPI spec, with a small facade for creating jobs and workflows and waiting on them.
---

The Go SDK is generated from the server's OpenAPI spec with openapi-generator, with a hand-written facade (`facade.go`) injected at generation time so it is regenerated alongside the core and cannot drift. The facade is the recommended entry point; the generated `APIClient` and its `*APIService` groups remain available for everything else.

- **Requires** Go 1.18 or newer.
- **Source**: [elision-labs/queueflow-sdk-go](https://github.com/elision-labs/queueflow-sdk-go), version 0.1.0.

## Install

```bash
go get github.com/elision-labs/queueflow-sdk-go
```

```go
import queueflow "github.com/elision-labs/queueflow-sdk-go"
```

## Quick start

```go
package main

import (
	"log"
	"time"

	queueflow "github.com/elision-labs/queueflow-sdk-go"
)

func main() {
	qf := queueflow.NewQueueFlow("http://localhost:8000", "dev")

	// Enqueue a job and wait for the result.
	job, err := qf.CreateJob("echo", map[string]interface{}{"hello": "world"})
	if err != nil {
		log.Fatal(err)
	}
	done, err := qf.WaitForJob(job.Id, 60*time.Second, 500*time.Millisecond)
	if err != nil {
		log.Fatal(err)
	}
	log.Println(done.Status, done.Result)

	// Declare and run a DAG workflow.
	dag := queueflow.NewWorkflowBuilder("etl").
		Step("extract", "echo").
		Step("transform", "echo", "extract").
		Step("load", "echo", "transform")
	wf, err := qf.CreateWorkflow(dag)
	if err != nil {
		log.Fatal(err)
	}
	finished, _ := qf.WaitForWorkflow(wf.Id, 60*time.Second, 500*time.Millisecond)
	log.Println(finished.Status)
}
```

## The facade

`NewQueueFlow(baseURL, token string) *QueueFlow` exposes:

| Member | Description |
| --- | --- |
| `CreateJob(task string, payload map[string]interface{}) (*Job, error)` | Enqueue, then fetch and return the full job. |
| `WaitForJob(jobID string, timeout, interval time.Duration) (*Job, error)` | Poll until `completed`, `failed`, or `cancelled`. |
| `CreateWorkflow(b *WorkflowBuilder) (*Workflow, error)` | Create from a builder; returns the full workflow. |
| `WaitForWorkflow(workflowID string, timeout, interval time.Duration) (*Workflow, error)` | Poll until a terminal workflow status. |
| `.Client` | The generated `*APIClient`: `.JobsAPI`, `.WorkflowsAPI`, `.CronAPI`, `.DlqAPI`, `.WorkerAPI`, `.SystemAPI`, `.HealthAPI`. |

`NewWorkflowBuilder(name)` builds a DAG with `.Step(name, taskName, dependsOn ...string)`. `Build()` validates locally (duplicate names, dangling dependencies, cycles) and returns an error before any network round-trip.

## Using the generated client

The generated services use a fluent request style and need a `context.Context`. Authentication is set once on the client's `Configuration`:

```go
ctx := context.Background()

page, _, err := qf.Client.JobsAPI.ListJobs(ctx).Status("retrying").Limit(50).Execute()
if err != nil {
	log.Fatal(err)
}
for _, j := range page.Jobs {
	fmt.Println(j.Id, j.TaskName)
}
if page.HasMore && page.NextCursor.IsSet() {
	page, _, err = qf.Client.JobsAPI.ListJobs(ctx).Cursor(*page.NextCursor.Get()).Execute()
}

req := queueflow.NewCreateCronRequest("nightly-report", "0 2 * * *", "build_report")
created, _, err := qf.Client.CronAPI.CreateCron(ctx).CreateCronRequest(*req).Execute()
```

Every operation and model is listed in the repository's [README](https://github.com/elision-labs/queueflow-sdk-go#documentation-for-api-endpoints) and matches the [REST API reference](/api) one to one, in PascalCase.

## Errors

Generated calls return a `*GenericOpenAPIError` whose `Body()` holds the server's `{"error": "...", "timestamp": "..."}` and whose accompanying `*http.Response` carries the status code. The facade's `WaitFor*` helpers return an error when the deadline passes.

## Worker protocol

No worker runtime ships with this SDK; `WorkerAPI` exposes `LeaseJobs`, `HeartbeatJob`, `CompleteJob`, and `FailJob` as raw calls. If you build a loop on them, three rules keep the at-least-once contract honest:

1. Worker routes authenticate with the **worker token**, not a tenant token. Build a second client for it: `cfg := queueflow.NewConfiguration(); cfg.AddDefaultHeader("Authorization", "Bearer "+workerToken)`.
2. Heartbeat every in-flight job at roughly half its lease interval. A heartbeat whose `status` is anything other than `running` (or an HTTP 409) means the server owns the outcome: abandon the handler and report nothing. Never process a leased batch sequentially without heartbeating the jobs still waiting; their leases expire and the server redelivers them.
3. Delivery is at-least-once, so handlers must be idempotent. Report permanent failures with `retryable: false` so they dead-letter immediately instead of burning retries.

```go
cfg := queueflow.NewConfiguration()
cfg.Servers = queueflow.ServerConfigurations{{URL: baseURL}}
cfg.AddDefaultHeader("Authorization", "Bearer "+workerToken)
worker := queueflow.NewAPIClient(cfg)

for {
	leased, _, err := worker.WorkerAPI.LeaseJobs(ctx, "images").
		LeaseJobsRequest(queueflow.LeaseJobsRequest{
			MaxJobs: queueflow.NewNullableInt32(ptr(int32(1))), LeaseSecs: queueflow.NewNullableInt32(ptr(int32(60))), WaitSecs: queueflow.NewNullableInt32(ptr(int32(20))),
		}).Execute()
	if err != nil { time.Sleep(time.Second); continue }
	for _, item := range leased.Jobs {
		result, err := resize(item.Job.Payload) // heartbeat from a goroutine while this runs
		if err != nil {
			worker.WorkerAPI.FailJob(ctx, item.Job.Id).FailJobRequest(*queueflow.NewFailJobRequest(item.LeaseToken, err.Error())).Execute()
			continue
		}
		req := queueflow.NewCompleteJobRequest(item.LeaseToken)
		req.SetResult(result)
		worker.WorkerAPI.CompleteJob(ctx, item.Job.Id).CompleteJobRequest(*req).Execute()
	}
}
```

The exact nullable-wrapper spellings come from the generated models; consult `model_lease_jobs_request.go` in the repository for the current signatures.

## Known limitation: `StreamJobEvents`

`JobsAPI.StreamJobEvents` cannot consume the server's SSE stream: it buffers the whole response until the stream closes (terminal status or the 15-minute cap) and returns it as one string. Use `WaitForJob` instead, or read `GET /api/v1/jobs/{id}/events` with `net/http` and parse the `text/event-stream` body yourself.
