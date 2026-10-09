---
title: Rust
description: Three crates for Rust users. queueflow-client for a first-party REST client and worker runtime, queueflow-sdk as the generated client, and queueflow-core to embed the engine itself.
---

Rust has the deepest integration because the engine is written in it. Choose by what you are building:

| Crate | Use it when | Version |
| --- | --- | --- |
| [`queueflow-client`](https://crates.io/crates/queueflow-client) | You talk to a running QueueFlow server from Rust, or you write a **remote worker** in Rust. First-party, reuses the engine's domain types, ships a worker runtime with automatic heartbeating. | 0.2.0 |
| [`queueflow-sdk`](https://crates.io/crates/queueflow-sdk) | You want the same openapi-generator shape as the other SDKs (for example to share patterns across a polyglot team). Generated client plus a small facade. | 0.2.1 |
| [`queueflow-core`](https://crates.io/crates/queueflow-core) | You **embed the engine** in your own binary: in-process handlers, in-memory testing, custom storage adapters. | 0.2.0 |
| [`queueflow-api`](https://crates.io/crates/queueflow-api) | You embed the HTTP layer (the axum router and OpenAPI document) alongside an embedded engine. | 0.2.0 |

All of them require Rust 1.96 or newer and live in the [queueflow-core](https://github.com/elision-labs/queueflow-core) workspace, except `queueflow-sdk`, which is in [queueflow-sdk-rust](https://github.com/elision-labs/queueflow-sdk-rust).

## Talking to a server with `queueflow-client`

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

Because the crate depends on `queueflow-core`, requests and responses use the engine's own `Job`, `Workflow`, `JobConfig`, and status types, so they cannot drift from the server. The client is integration-tested against the real router on every CI run.

## Remote workers with `queueflow-client`

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

## The generated `queueflow-sdk`

```bash
cargo add queueflow-sdk tokio --features tokio/full
```

```rust
use std::time::Duration;
use queueflow_sdk::{QueueFlow, WorkflowBuilder};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let qf = QueueFlow::new("http://localhost:8000", "dev");

    let payload = std::collections::HashMap::from([("hello".to_owned(), serde_json::json!("world"))]);
    let job = qf.create_job("echo", Some(payload)).await?;
    let done = qf.wait_for_job(&job.id, Duration::from_secs(60), Duration::from_millis(500)).await?;
    println!("job {} finished as {}", done.id, done.status);

    let builder = WorkflowBuilder::new("etl")
        .step("extract", "extract_task", &[])
        .step("transform", "transform_task", &["extract"])
        .step("load", "load_task", &["transform"]);
    let wf = qf.create_workflow(&builder).await?;   // build() validates the DAG locally first
    let finished = qf.wait_for_workflow(&wf.id, Duration::from_secs(300), Duration::from_secs(1)).await?;
    println!("workflow {} finished as {}", finished.id, finished.status);
    Ok(())
}
```

The facade adds `QueueFlow::new`, `create_job`, `create_workflow`, `wait_for_job`, `wait_for_workflow`, and `WorkflowBuilder`. Everything else (leasing, heartbeats, batch enqueue, cron, DLQ, stats, diagrams) is on the generated modules, for example `queueflow_sdk::apis::worker_api::lease_jobs(&qf.config, …)`. For a Rust worker, prefer `queueflow-client`; if you do call `worker_api` directly, clone `qf.config` and set `bearer_access_token` to the worker token.

The generated `jobs_api::stream_job_events` cannot consume SSE; use `wait_for_job` or a hand-rolled SSE consumer over `GET /api/v1/jobs/{id}/events`.

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
queueflow-core = { version = "0.2", features = ["postgres"] }
```

```rust
let pool = queueflow_core::connect(&database_url, 20).await?;
queueflow_core::migrate(&pool).await?;                 // embedded migrations
let store = Arc::new(PostgresJobStore::new(pool));
let engine = Engine::builder(store, Arc::new(SystemClock))
    .register_fn("resize-image", |payload: Map| async move { /* … */ Ok(Map::new()) })
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
