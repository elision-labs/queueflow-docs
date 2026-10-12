---
title: Rust
description: Three crates for Rust users. queueflow-sdk as the generated client with a facade and a concurrent worker runtime, queueflow-client as the first-party client that reuses the engine's types, and queueflow-core to embed the engine itself.
---

Rust has the deepest integration because the engine is written in it. Choose by what you are building:

| Crate | Use it when | Version |
| --- | --- | --- |
| [`queueflow-sdk`](https://crates.io/crates/queueflow-sdk) | You want the same openapi-generator shape as the other SDKs (for example to share patterns across a polyglot team). Generated client plus a facade with one method per endpoint, `wait_for_*` pollers, a workflow builder, typed errors, and `run_worker`, a concurrent worker runtime with graceful stop. | 0.5.0 |
| [`queueflow-client`](https://crates.io/crates/queueflow-client) | You talk to a running QueueFlow server from Rust and want the engine's own domain types. First-party, depends on `queueflow-core`, ships a worker runtime with automatic heartbeating. | 0.6.0 |
| [`queueflow-core`](https://crates.io/crates/queueflow-core) | You **embed the engine** in your own binary: in-process handlers, in-memory testing, custom storage adapters. | 0.6.0 |
| [`queueflow-api`](https://crates.io/crates/queueflow-api) | You embed the HTTP layer (the axum router and OpenAPI document) alongside an embedded engine. | 0.6.0 |

All of them require Rust 1.96 or newer and live in the [queueflow-core](https://github.com/elision-labs/queueflow-core) workspace, except `queueflow-sdk`, which is in [queueflow-sdk-rust](https://github.com/elision-labs/queueflow-sdk-rust). The crate is `queueflow-sdk`; the bare `queueflow` crate name belongs to the server and CLI binary.

## The generated `queueflow-sdk`

`queueflow-sdk` is generated from the server's OpenAPI spec with openapi-generator, with a hand-written facade (`src/facade.rs`) injected at generation time so it is regenerated alongside the core and cannot drift. The facade is the recommended entry point; the generated `apis::*` functions and `models::*` types remain available for everything else. It is async (tokio and reqwest).

### Install

```toml
[dependencies]
queueflow-sdk = "0.5.0"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "signal"] }
serde_json = "1"
```

### Quick start

```rust
use std::collections::HashMap;

use queueflow_sdk::{QueueFlow, WaitOptions, WorkflowBuilder};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let qf = QueueFlow::new("http://localhost:8000", "dev");

    // Enqueue a job and wait for the result.
    let payload = HashMap::from([("hello".to_owned(), serde_json::json!("world"))]);
    let id = qf.create_job("echo", Some(payload)).await?;
    let done = qf.wait_for_job(&id, WaitOptions::default()).await?;
    println!("job {} finished as {} with {:?}", done.id, done.status, done.result);
    // completed, Some({"hello": "world", "echoed": true})

    // Declare and run a DAG workflow. `build()` validates it locally (duplicate
    // names, dangling deps, cycles) before anything goes over the wire.
    let dag = WorkflowBuilder::new("etl")
        .step("extract", "echo", &[])
        .step("transform", "echo", &["extract"])
        .step("load", "echo", &["transform"]);
    let wf_id = qf.create_workflow(&dag).await?;
    let finished = qf.wait_for_workflow(&wf_id, WaitOptions::default()).await?;
    println!("workflow {} finished as {}", finished.id, finished.status);
    Ok(())
}
```

`echo` is a handler built into the server; it returns the payload plus `"echoed": true`. The `"dev"` token only works against a server started with `--dev`; see [Authentication and tenants](/concepts/auth).

### Client

```rust
use std::time::Duration;
use queueflow_sdk::{QueueFlow, QueueFlowOptions};

let qf = QueueFlow::new(base_url, token);

// or, with a separate worker token and a custom timeout:
let qf = QueueFlow::with_options(
    QueueFlowOptions::new("http://localhost:8000", "dev") // tenant token (required)
        .worker_token("worker-secret")   // for lease/heartbeat/complete/fail and run_worker
        .timeout(Duration::from_secs(30)), // per-request HTTP timeout (default 30s)
)?;
```

`QueueFlow` is `Clone` (cheap: it wraps two `reqwest::Client`s). The per-request timeout applies to every call except the lease long-poll, which is bounded by `wait_secs + 35s` instead. `with_options` returns `FacadeError::InvalidOptions` when `base_url` or `token` is empty.

| Field | Description |
| --- | --- |
| `qf.config` | The generated `Configuration` with the tenant token; pass `&qf.config` to any `apis::*` function. |
| `qf.worker_config` | The generated `Configuration` with the worker token and no client-level timeout. |

`Json` is `HashMap<String, serde_json::Value>`, the type of every payload, result, context, and metadata.

### Jobs

| Method | Description |
| --- | --- |
| `create_job(task, payload: Option<Json>) -> String` | Enqueue with the server defaults; returns the job id. |
| `create_job_with_options(task, CreateJobOptions) -> String` | Enqueue with config, idempotency key, and `run_at`; returns the job id. |
| `get_job(id) -> models::Job` | Fetch a job. |
| `list_jobs(&ListOptions) -> models::ListJobsResponse` | List jobs (`status`, `queue`, `limit`, `offset`, `order_by`, `include_total`, `cursor`, `created_after`, `created_before`). |
| `cancel_job(id)` | Cancel a job. |
| `wait_for_job(id, WaitOptions) -> models::Job` | Poll until `completed`, `failed`, or `cancelled`. |

`CreateJobOptions` carries everything the create request accepts. Every field is an `Option` with `Default`; unset fields are not sent, so the server defaults apply:

```rust
use queueflow_sdk::{CreateJobOptions, Json};
use queueflow_sdk::models::BackoffStrategy;

let id = qf.create_job_with_options("send-email", CreateJobOptions {
    payload: Some(Json::from([("to".to_owned(), serde_json::json!("ada@example.com"))])),
    queue: Some("emails".to_owned()),               // override the destination queue
    priority: Some(5),                              // higher is claimed first
    max_retries: Some(3),                           // attempts before dead-lettering
    timeout_secs: Some(30),                         // per-attempt timeout, seconds
    retry_backoff: Some(BackoffStrategy::Exponential),
    retry_delay_secs: Some(10),                     // base retry delay
    retry_max_delay_secs: Some(600),                // cap on any computed delay
    jitter_factor: Some(0.1),                       // 0.0..=1.0, 0.1 = +/-10%
    idempotency_key: Some("signup-42".to_owned()),  // sent as the Idempotency-Key header
    run_at: Some("2026-10-11T09:00:00Z".to_owned()), // RFC 3339; don't run before this instant
}).await?;
```

The same `idempotency_key` returns the original job id. `run_at` delays the first run; the job is created immediately but stays invisible to workers until then.

`WaitOptions` is `{timeout, interval}` with a `Default` of 60s and 500ms (`WaitOptions::with_timeout(d)` keeps the default interval). Past the deadline the call returns `FacadeError::Timeout`.

List responses carry `next_cursor` when there are more pages; pass it back as `cursor` for keyset pagination, which is cheaper than deep `offset`.

### Workflows

| Method | Description |
| --- | --- |
| `create_workflow(&WorkflowBuilder) -> String` | Validate the DAG locally, create it, return the workflow id. |
| `get_workflow(id)` / `list_workflows(&ListOptions)` / `cancel_workflow(id)` | Fetch, list, cancel. |
| `workflow_diagram(id) -> models::WorkflowDiagramResponse` | Mermaid (`graph TD`) diagram of the DAG. |
| `workflow_steps(id) -> Vec<models::WorkflowStepState>` | Runtime status of every step, with the job id executing it. |
| `wait_for_workflow(id, WaitOptions) -> models::Workflow` | Poll until `completed`, `failed`, `partially_failed`, or `cancelled`. |

### Workflow builder

```rust
use queueflow_sdk::models::{JobConfig, OnFailure};
use queueflow_sdk::{Json, StepOptions, WorkflowBuilder};

let dag = WorkflowBuilder::new("order_123")
    .step("validate", "validate_order", &[])
    .step_with_options("pay", "process_payment", StepOptions {
        after: vec!["validate".to_owned()],
        payload: Some(Json::from([("amount".to_owned(), serde_json::json!(42))])),
        on_failure: Some(OnFailure::Halt),
        config: Some(JobConfig { max_retries: Some(5), ..JobConfig::new() }),
        ..StepOptions::default()
    })
    .step("ship", "create_shipment", &["pay"])
    .context(Json::from([("source".to_owned(), serde_json::json!("web"))]));
let body = dag.build()?; // duplicate names, dangling deps, and cycles fail here, before any request
```

`step(name, task, after)` adds a step gated on the named `after` steps. `step_with_options(name, task, StepOptions)` takes:

| Field | Meaning |
| --- | --- |
| `after` | `Vec<String>` of step names that must complete before this one runs. |
| `payload` | `Option<Json>` passed to the task handler. |
| `config` | `Option<models::JobConfig>` override for this step (retries, timeout, priority, and so on). |
| `on_failure` | `Some(OnFailure::Halt)` (default), `Skip`, or `Continue`. |
| `on_success` | `Option<models::OnSuccess>`, the step's success policy. |
| `metadata` | `Option<Json>` attached to the step. |

`context` and `metadata` seed the workflow-level fields and merge across calls. `create_workflow` calls `build()` for you; a structurally invalid DAG is `FacadeError::InvalidWorkflow`.

### Worker

`run_worker` is a complete remote worker: it leases jobs from one queue, dispatches each to an async handler by task name on its own tokio task, heartbeats while handlers run, and reports the outcome. The engine owns retries, backoff, the dead-letter queue, and workflow advancement, so a Rust handler gets the same semantics as one compiled into the server.

```rust
use std::time::Duration;

use queueflow_sdk::{HandlerError, Handlers, Json, QueueFlow, QueueFlowOptions, WorkerOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let qf = QueueFlow::with_options(
        QueueFlowOptions::new("http://localhost:8000", &std::env::var("QUEUEFLOW_TOKEN")?)
            .worker_token(&std::env::var("QUEUEFLOW_WORKER_TOKEN")?), // the server's --worker-token
    )?;

    let handlers = Handlers::new()
        .register("send-email", |ctx| async move {
            let payload = ctx.job.payload.unwrap_or_default();
            if payload.get("to").is_none() {
                return Err(HandlerError::non_retryable("no recipient")); // dead-letters immediately
            }
            send_email(&payload).await?; // any std::error::Error converts to a retryable failure
            Ok(Json::from([("sent".to_owned(), serde_json::json!(true))]))
        })
        .register("transcode", |ctx| async move {
            // ctx.cancel fires if the lease is lost or the drain timeout passes; the
            // handler future is dropped at the same moment, so this matters for
            // work the handler spawned elsewhere.
            let payload = ctx.job.payload.unwrap_or_default();
            for chunk in chunks(&payload) {
                if ctx.cancel.is_cancelled() {
                    return Ok(Json::new()); // the server owns the outcome now
                }
                process(chunk).await?;
            }
            Ok(Json::from([("ok".to_owned(), serde_json::json!(true))]))
        });

    let opts = WorkerOptions {
        concurrency: 4,
        drain_timeout: Duration::from_secs(30),
        ..WorkerOptions::default()
    };
    // Cancelling the stop token stops the worker: the in-flight long poll is
    // abandoned at once and running handlers get drain_timeout to finish.
    let stop = opts.stop.clone();
    let worker = tokio::spawn({
        let qf = qf.clone();
        async move { qf.run_worker("orders", handlers, opts).await }
    });

    tokio::signal::ctrl_c().await?;
    stop.cancel();
    worker.await??; // Err on a 401/403 from the lease call: wrong or missing worker token
    Ok(())
}
```

#### Signature

```rust
pub async fn run_worker(&self, queue: &str, handlers: Handlers, opts: WorkerOptions) -> Result<(), FacadeError>

pub type HandlerResult = Result<Json, HandlerError>;
pub struct JobContext { pub job: models::Job, pub cancel: CancelToken }
// Handlers::register<F, Fut>(self, task: &str, f: F) where F: Fn(JobContext) -> Fut, Fut: Future<Output = HandlerResult>
```

#### Options

`WorkerOptions` implements `Default`; override the fields you need with struct update syntax:

| Field | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `1` | Jobs in flight at once. Each lease call asks for as many jobs as there are free slots; no lease is issued while every slot is busy. |
| `lease_secs` | `30` | Lease duration per job. Every in-flight job is heartbeated at half this interval. |
| `wait_secs` | `20` | Server-side long poll when the queue is empty (clamped to 0..=30). |
| `drain_timeout` | `30s` | How long `run_worker` waits for in-flight handlers after `stop` fires. Past it they are cancelled and dropped. |
| `stop` | a fresh `CancelToken` | Cancel this token to stop the worker. Keep a clone before passing the options in. |
| `on_error` | `None` | An `Arc<dyn Fn(&FacadeError)>` called with every transient lease failure instead of the default throttled `eprintln!` (first failure, then every 30th). |

#### Handler contract

- A handler is any `Fn(JobContext) -> impl Future<Output = HandlerResult>` that is `Send + Sync + 'static`. `ctx.job` is the leased `models::Job` (`id`, `task_name`, `payload`, `config`, and so on); `ctx.cancel` is a `CancelToken` with `is_cancelled()` and an async `cancelled()`.
- Return `Ok(Json)` to store as the job's `result`. For a workflow step the result is merged into the workflow context.
- Return `Err(HandlerError::Retryable(_))` to fail the attempt as **retryable**: the engine schedules a retry if budget remains, otherwise dead-letters the job with reason `max_attempts_exceeded`. Any `std::error::Error` converts into `Retryable` with `?`.
- Return `Err(HandlerError::NonRetryable(_))` (`HandlerError::non_retryable(msg)`) to fail the attempt as **non-retryable**: the job is dead-lettered immediately with reason `non_retryable`. Use it for bad input and other permanent errors.
- A leased job whose task has no handler is failed non-retryably, so it does not block the queue. A panicking handler kills only its own task; its lease expires and the server redelivers.
- Delivery is at-least-once. Key side effects on `ctx.job.id` or a natural key in the payload.

#### Heartbeats and cancellation

Each in-flight job is heartbeated every `lease_secs / 2` seconds, extending the lease by `lease_secs`, for as long as the handler runs. If a heartbeat reports that the job is no longer `running` (cancelled mid-run, or the lease expired and was reclaimed) or answers `409`, the server owns the outcome: the runtime fires `ctx.cancel`, drops the handler future, and reports nothing.

If reporting an outcome fails (the server is unreachable, for example), the runtime prints a warning and does not retry the report. The lease expires and the engine redelivers the job; a reporting error is never converted into a job failure.

#### Stop and drain

Cancel `opts.stop`. The in-flight lease long-poll is abandoned immediately, so stopping never waits out `wait_secs`. Handlers already running get up to `drain_timeout` to finish and report. Past the deadline the runtime fires each remaining job's `ctx.cancel`, drops the handler futures, and `run_worker` returns `Ok(())`; the unreported leases expire and the server redelivers them.

#### Lease errors

`run_worker` returns the `FacadeError::Http` when the lease call is rejected with `401` or `403`, after the same drain, because a wrong or missing worker token cannot heal by retrying. Any other lease error (a `5xx`, a network failure) goes to `on_error`, or to the default throttled `eprintln!`, and the loop backs off one second before trying again.

#### The raw protocol

The lower-level calls are also exposed, authenticated with the worker token: `lease_jobs(queue, LeaseOptions { max_jobs, lease_secs, wait_secs })`, `heartbeat_job(&lease, extend_secs)`, `complete_job(&lease, result)`, `fail_job(&lease, message, retryable)`. A hand-rolled loop must honour the same contract as `run_worker`; see [Remote workers](/concepts/workers).

### Cron

| Method | Description |
| --- | --- |
| `create_cron(name, schedule, task) -> String` | Register a recurring enqueue (5-field crontab, UTC); returns the schedule id. |
| `create_cron_with_options(name, schedule, task, CreateCronOptions) -> String` | Also set `payload`, `queue`, and a `config` override. |
| `get_cron(id)` / `list_crons(&ListOptions)` / `delete_cron(id)` | Fetch, list, delete. |
| `pause_cron(id)` / `resume_cron(id)` | Stop firings, or resume at the next future occurrence. |

### Dead letters

| Method | Description |
| --- | --- |
| `list_dead_letters(&ListOptions)` / `get_dead_letter(id: i64)` | Inspect terminally failed jobs. |
| `replay_dead_letter(id: i64) -> String` | Re-run one as a fresh job; returns the new job id. A second replay is a `409`. |

### System

| Method | Description |
| --- | --- |
| `stats() -> models::StatsSnapshot` | Engine counters. |
| `queues() -> Vec<models::QueueStats>` | Live per-queue backlog: `pending`, `scheduled`, `running`, `oldest_pending_age_secs`. |
| `tasks() -> Vec<String>` | Registered task handler names. |
| `health()` / `ready()` | `GET /health` and `GET /ready`. |

`queues()` (`GET /api/v1/queues`) returns one entry per queue that currently has non-terminal jobs, so you can decide whether to add workers; idle queues are omitted.

### Everything else: the generated client

Anything the facade does not wrap (batch enqueue, raw request bodies) is one call away in `queueflow_sdk::apis`, each function taking `&qf.config`:

```rust
use queueflow_sdk::apis::jobs_api;
use queueflow_sdk::models::CreateBatchJobsRequest;

let batch = jobs_api::create_batch_jobs(&qf.config, CreateBatchJobsRequest::new(reqs)).await?;
```

Per-endpoint and per-model reference for the generated layer lives in the repository's [`docs/`](https://github.com/elision-labs/queueflow-sdk-rust/tree/main/docs).

### Errors

Facade methods return `FacadeError`:

| Variant | When |
| --- | --- |
| `Http { op, status, body }` | A non-2xx response; `err.status()` returns `Some(status)`. |
| `Transport { op, source }` | No response, or it did not decode (connection refused, timeout, TLS, JSON). |
| `InvalidWorkflow(String)` | A DAG failed local validation, before any request. |
| `InvalidOptions(String)` | `with_options` was given an empty `base_url` or `token`, or the HTTP client could not be built. |
| `Timeout(String)` | A `wait_for_*` poller, or a worker-protocol call, ran out of time. |

```rust
use queueflow_sdk::FacadeError;

match qf.get_job("missing").await {
    Ok(job) => println!("{}", job.status),
    Err(err) if err.status() == Some(404) => println!("no such job"),
    Err(FacadeError::Http { op, status, body }) => eprintln!("{} failed: HTTP {}: {}", op, status, body),
    Err(other) => return Err(other.into()),
}
```

Worker handlers return `HandlerError`: `Retryable(String)` (the server applies the job's retry policy) or `NonRetryable(String)` (dead-letters immediately). Any `std::error::Error` converts into `Retryable` with `?`; `HandlerError` deliberately does not implement `std::error::Error` itself, which is what makes that blanket conversion possible.

Generated functions return `apis::Error<OperationError>` directly; its `ResponseError` variant carries the HTTP `status`, raw `content`, and the decoded error `entity`.

### Known limitation: `stream_job_events`

The generated `jobs_api::stream_job_events` cannot consume the server's SSE stream: it buffers the whole response until the stream closes and then fails to decode it. Use `wait_for_job` instead, or a hand-rolled SSE consumer over `GET /api/v1/jobs/{id}/events`.

### Conformance tests

`tests/live.rs` runs the facade against a real QueueFlow server started with the default `queueflow serve` (`--mode all`, so the built-in `echo` handler is registered). It creates and waits on an `echo` job, checks idempotent re-creation and list filters, runs a two-step workflow, exercises the cron, dead-letter, queue backlog, and stats endpoints, and runs `run_worker` against a dedicated queue: one scenario completes a job with a handler only the test knows, another dead-letters a job with `HandlerError::non_retryable` and replays it. The tests skip themselves unless `QUEUEFLOW_URL` is set, so plain `cargo test` and CI stay offline.

```bash
QUEUEFLOW_URL=http://localhost:8000 \
QUEUEFLOW_TOKEN=dev \
QUEUEFLOW_WORKER_TOKEN=worker-secret \
cargo test --test live
```

`QUEUEFLOW_TOKEN` is the tenant token (default `dev`). `QUEUEFLOW_WORKER_TOKEN` is the server's `--worker-token`; it defaults to the tenant token, which only works when the server runs without one.

## The first-party `queueflow-client`

`queueflow-client` is the alternative for Rust code that already depends on the engine: because it depends on `queueflow-core`, requests and responses use the engine's own `Job`, `Workflow`, `JobConfig`, and status types, so they cannot drift from the server. It also ships a worker runtime. The client is integration-tested against the real router on every CI run.

```bash
cargo add queueflow-client tokio --features tokio/full
```

```rust
use queueflow_client::Client;

let client = Client::new("http://localhost:8000", "my-tenant-token");
let job = client.create_job("resize-image", payload, Default::default()).await?;
let done = client.wait_for_job(&job.id, std::time::Duration::from_secs(60)).await?;
println!("{:?} {:?}", done.status, done.result);
```

### Remote workers with `queueflow-client`

```rust
use queueflow_client::{Client, Map};
use queueflow_client::worker::{Worker, WorkerOptions};

// Use the deployment's worker token, not a tenant token.
let client = Client::new("http://localhost:8000", worker_token);

Worker::new(client, "images", WorkerOptions::default())
    .register("resize-image", |job| async move {
        // ... do the work ...
        Ok(Map::new())
    })
    .run()
    .await;
```

The worker leases jobs over HTTP, heartbeats while handlers run (observing mid-run cancellation), reports outcomes, processes a leased batch concurrently, and gets the same retry, dead-letter, and workflow semantics as handlers compiled into the server. Return `Err` from a handler to fail the attempt; the error type decides whether it is retryable.

## Embedding the engine

`queueflow-core` is the engine as a library. It is written against a `JobStore` port with two adapters: `InMemoryJobStore`, which runs the entire engine (retries, timeouts, workflows, janitor sweeps) deterministically with a controllable `TestClock`, and `PostgresJobStore` behind the `postgres` feature.

### In memory, no database

```rust
use std::sync::Arc;
use queueflow_core::*;
use queueflow_core::task::builtin;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), EngineError> {
    let clock = Arc::new(SystemClock);
    let store = Arc::new(InMemoryJobStore::new(clock.clone()));

    let engine = Engine::builder(store, clock)
        .register("echo", builtin::echo())
        .register_fn("greet", |p: Map| async move {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("world");
            Ok(Map::from_iter([("greeting".into(), json!(format!("hello {name}")))]))
        })
        .build();

    let id = engine.enqueue("greet", Map::from_iter([("name".into(), json!("ada"))]), Default::default()).await?;
    engine.process_once("default").await?;          // drive one job (tests and demos)
    println!("{:?}", engine.get_job(&id).await?.result);
    Ok(())
}
```

This is also how you test code that uses QueueFlow: no Docker, no Postgres, and a `TestClock` you can advance to make retries and timeouts fire on demand.

### On PostgreSQL

```toml
[dependencies]
queueflow-core = { version = "0.6", features = ["postgres"] }
```

```rust
let pool = queueflow_core::connect(&database_url, 20).await?;
queueflow_core::migrate(&pool).await?;                 // embedded migrations
let store = Arc::new(PostgresJobStore::new(pool));
let engine = Engine::builder(store, Arc::new(SystemClock))
    .register_fn("resize-image", |payload: Map| async move { /* ... */ Ok(Map::new()) })
    .build();

let workers = engine.run_workers("default");          // supervised worker pool
let janitor = engine.run_janitor();                   // lease recovery, workflow self-heal, retention
```

Handlers registered this way run in-process on the named queue and appear in `GET /api/v1/tasks`. Add `queueflow-api` to serve the REST API from the same binary, or run the stock `queueflow serve --mode api` next to it and let your binary be the `worker`.

### Workflows from Rust

```rust
use queueflow_core::workflow::{WorkflowBuilder, StepBuilder};
use queueflow_core::OnFailure;

let req = WorkflowBuilder::new("order_123")
    .step(StepBuilder::new("validate").task("validate_order"))
    .step(StepBuilder::new("pay").task("process_payment").after("validate"))
    .step(StepBuilder::new("ship").task("create_shipment").after("pay").on_failure(OnFailure::Continue))
    .build()?;                                        // validates the DAG (cycles -> Err)

let workflow_id = engine.create_workflow(req, None).await?;
```

## Documentation

- `cargo doc --open -p queueflow-core` for the full rustdoc.
- Runnable examples: `cargo run --example in_memory_jobs -p queueflow-core` and `cargo run --example workflow -p queueflow-core`.
