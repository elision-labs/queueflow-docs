---
title: Examples
description: Two complete, runnable applications. Ship-It, an order pipeline with Node and Python workers, and an Express service that offloads work to QueueFlow.
---

## Ship-It: the order-pipeline demo

[elision-labs/queueflow-shipit-demo](https://github.com/elision-labs/queueflow-shipit-demo), live at [demo.queueflow.dev](https://demo.queueflow.dev).

A tiny storefront where every order is a workflow. Place one and watch it move through a seven-step DAG executed by a **Node worker** and a **Python worker** against one QueueFlow engine. The app has no database of its own: everything the UI shows comes from the engine's API through `@queueflow/sdk` and the Python `queueflow` package.

```text
                 ┌─ charge_payment ──┐                         ┌─ send_confirmation   (skip on failure)
validate_order ──┤                   ├─ reserve ─ invoice ─────┤
                 └─ fraud_check ─────┘                         └─ notify_warehouse ──→ pack_order
                    (halt on failure)                                                  (Python, own queue)
```

What each scenario demonstrates:

| Order | Scenario |
| --- | --- |
| Anvil | The happy path, with ambient payment chaos (`PAYMENT_FAILURE_RATE`, default 0.25). |
| Bubble wrap | A deterministic retry storm: payment fails three times, backs off exponentially with jitter, then clears. The step's partial config (`max_retries: 4, retry_delay_secs: 2, retry_max_delay_secs: 15, jitter_factor: 0.2`) is filled in by the engine's defaults. |
| Suspicious briefcase | A fraud halt: a `NonRetryableError` dead-letters the job, the step's `halt` policy fails the workflow and cancels everything downstream. Replay it from the dispatch office. |
| "This mailbox bounces" | The `skip` policy: the confirmation email fails twice and dead-letters, but the order still ships and the workflow ends `partially_failed`. |

Also on show: killing the Node worker mid-order and watching the janitor reclaim the lease, a `review_request` job scheduled 90 seconds out with `runAt` and guarded by an idempotency key, keyset pagination in the dispatch office, live engine stats, and a standing cron schedule you can pause and resume.

```bash
git clone https://github.com/elision-labs/queueflow-shipit-demo && cd queueflow-shipit-demo
make demo        # engine up (pulls ghcr.io/elision-labs/queueflow) + workers + smoke test
make web         # storefront http://localhost:3100, dispatch office /admin.html
make worker      # the Node worker (orders queue)
make worker-py   # the Python worker (warehouse queue)
```

Requirements: Docker, Node 18 or newer, Python 3.10 or newer. The compose file runs the engine with strict auth (`--api-keys shipit-key:shipit --worker-token shipit-worker-token`), so it also serves as a worked example of [Authentication and tenants](/concepts/auth).

| Piece | Where |
| --- | --- |
| The DAG, per-step configs, and failure policies | `src/pipeline.ts` |
| Node worker (leases `orders`, heartbeats via `qf.worker.run`) | `src/worker.ts` |
| Python worker (leases `warehouse` with the Python facade's `run_worker`) | `worker-py/worker.py` |
| Storefront and API (Express, SSE to the browser) | `src/server.ts` |
| Smoke test proving all four scenarios | `scripts/smoke.ts` |

## Express example

[elision-labs/queueflow-nodejs-example](https://github.com/elision-labs/queueflow-nodejs-example).

A small Express service demonstrating the realistic backend pattern: HTTP handlers stay fast by **enqueuing** work and returning `202 Accepted` with a status URL, and a TypeScript worker in the same app executes the jobs over the remote worker protocol.

```text
client ──POST /signup──▶ Express ──enqueue "welcome email"──▶ QueueFlow
   ▲                        │                                     │ lease/complete
   └────202 + statusUrl─────┘                                     ▼
         GET /jobs/:id ◀── status/result ──────────── worker (src/worker.ts)
```

It shows:

- fire-and-forget jobs (`POST /signup` enqueues a welcome email);
- a real TypeScript handler running in `src/worker.ts`;
- idempotent enqueue with an `Idempotency-Key`, so re-submitting the same email returns the original job;
- status polling (`GET /jobs/:id`) and streaming (`GET /jobs/:id/stream`, Server-Sent Events);
- a three-step `extract → transform → load` workflow built with `wf()` (`POST /reports`) and its Mermaid diagram;
- mapping SDK errors (`NotFoundError`, `ApiError`, …) to HTTP status codes.

```bash
git clone https://github.com/elision-labs/queueflow-nodejs-example && cd queueflow-nodejs-example
make demo     # Postgres + engine (started with --dev) + npm install + end-to-end smoke test
make app      # run the example API on :3000
make down     # stop everything
```

Requirements: Docker, Rust, and Node. The example builds the engine from a sibling checkout of `queueflow-core` and depends on the published `@queueflow/sdk` package.

## Smaller snippets

- [Quick start](/quickstart): curl through the whole API, then a 15-line TypeScript worker.
- [Remote workers](/concepts/workers#writing-a-worker-from-scratch): the lease loop in shell.
- [Rust](/sdks/rust#embedding-the-engine): run the engine in memory with no database.
- The engine repository's [examples directory](https://github.com/elision-labs/queueflow-core/tree/main/crates/queueflow-core/examples): `in_memory_jobs` and `workflow`.
