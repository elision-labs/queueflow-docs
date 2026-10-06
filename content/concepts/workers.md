---
title: Remote workers
description: The HTTP protocol that lets job handlers run in any language, with the same retry, dead-letter, and workflow semantics as handlers compiled into the server.
---

QueueFlow has two execution models. **In-process handlers** are Rust functions registered in the server binary. **Remote workers** are separate processes, in any language, that lease jobs from a queue over HTTP, do the work, and report back. Both get the same guarantees: at-least-once delivery, durable retries, dead-lettering, workflow advancement, and cancellation.

This page describes the protocol. The [TypeScript](/sdks/typescript#worker-qfworker) and [Rust](/sdks/rust#remote-workers-with-queueflow-client) SDKs wrap it in a ready-made worker loop; the Python and Go SDKs expose the raw calls.

## The protocol

```text
   worker                                              server
     │  POST /api/v1/queues/{queue}/lease                 │
     │  {max_jobs, lease_secs, wait_secs}                 │
     │ ─────────────────────────────────────────────────► │  claims rows FOR UPDATE SKIP LOCKED,
     │ ◄───────────────────────────────────────────────── │  sets status=running, locked_until, lease_token
     │  {jobs:[{job, lease_token}]}                       │
     │                                                    │
     │  … run the handler …                               │
     │                                                    │
     │  POST /api/v1/jobs/{id}/heartbeat   (every ~lease/2)
     │  {lease_token, extend_secs}                        │
     │ ─────────────────────────────────────────────────► │  extends locked_until if the token matches
     │ ◄───────────────────────────────────────────────── │
     │  {status:"running"}   (anything else: stop)        │
     │                                                    │
     │  POST /api/v1/jobs/{id}/complete  {lease_token, result}
     │  or   /api/v1/jobs/{id}/fail      {lease_token, error, retryable}
     │ ─────────────────────────────────────────────────► │  verifies the token, records the outcome,
     │ ◄───────────────────────────────────────────────── │  schedules a retry or dead-letters,
     │  204                                               │  advances the owning workflow
```

### Lease

`POST /api/v1/queues/{queue}/lease`

| Body field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `max_jobs` | 1 to 100 | 1 | Jobs to claim in one call. |
| `lease_secs` | 1 to 3600 | 30 | How long the worker owns each job before it must heartbeat. |
| `wait_secs` | 0 to 30 | 0 | Long-poll: if the queue is empty, wait up to this long for work before returning an empty list. |

The response is `{"jobs": [{"job": {…}, "lease_token": "…"}]}`, possibly empty. Jobs are returned in priority order (higher first), then by `scheduled_at` and `created_at`. Workers only see jobs whose `scheduled_at` has passed.

Long-polling is cheap: the server waits on a PostgreSQL `LISTEN/NOTIFY` channel and wakes as soon as a job is inserted, with a 5 second safety poll in case a notification is missed. Loop on `wait_secs: 20` or so rather than hammering an empty queue.

### Lease token

The `lease_token` is an unguessable UUID regenerated on every claim. It is proof of ownership: every heartbeat, complete, and fail call must present it. If the lease expired and the janitor reclaimed the job, the old token is stale and the server answers `409`. That is what makes delivery safe: a worker that was presumed dead and comes back cannot overwrite a job that has since been retried, completed elsewhere, or cancelled.

### Heartbeat

`POST /api/v1/jobs/{id}/heartbeat` with `{"lease_token": "…", "extend_secs": 60}` (1 to 3600) sets a new lease deadline measured from now. The response is the job's current status:

- `running`: the lease was extended; keep working.
- anything else (`cancelled`, `completed`, `failed`): the lease was **not** extended. The server owns the outcome. Abandon the handler and report nothing.
- HTTP `409`: the lease was lost. Same response: stop.

Heartbeat at roughly half the lease interval. If you lease a batch, heartbeat every job in it, including the ones still waiting their turn; otherwise their leases expire and the server redelivers them to another worker while you still hold them.

### Complete and fail

`POST /api/v1/jobs/{id}/complete` with `{"lease_token": "…", "result": {…}}` records success. `result` is stored on the job and, for workflow steps, merged into the workflow context. Completing is idempotent: replaying it against an already-finished job also returns `204`.

`POST /api/v1/jobs/{id}/fail` with `{"lease_token": "…", "error": "…", "retryable": true}` records a failure. With `retryable: true` (the default) the engine schedules a retry if budget remains, otherwise dead-letters the job. With `retryable: false` the job is dead-lettered immediately. See [Retries](/concepts/retries).

Both return `204` on success, `404` for an unknown job, and `409` when the lease is no longer held.

## Authentication

Worker-protocol routes are the only routes that cross tenant boundaries: a worker leases whatever is on the queue and sees every tenant's payloads. They therefore take a separate credential, the **worker token**, configured on the server with `--worker-token`. A tenant token on these routes is a `403`.

With no `--worker-token` configured the server is in development mode and accepts any authenticated caller as a worker, warning at startup. Never run that way on a network you do not control. See [Authentication and tenants](/concepts/auth).

## Queues

A worker leases from one queue by name. Queues are created implicitly: enqueue a job with `"config": {"queue": "images"}` and `images` exists. Use queues to route work to the processes that can do it (a Python queue for machine-learning jobs, a Node queue for email), to isolate noisy neighbours, and to scale independently. Workflow steps always run on the server's default queue, so put a worker there if your steps are not in-process handlers.

## Writing a worker from scratch

The loop every SDK runtime implements, in shell for clarity:

```bash
BASE=http://localhost:8000
AUTH='Authorization: Bearer <worker-token>'

while true; do
  leased=$(curl -s -X POST "$BASE/api/v1/queues/images/lease" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"max_jobs":1,"lease_secs":60,"wait_secs":20}')
  id=$(echo "$leased"    | jq -r '.jobs[0].job.id // empty')
  token=$(echo "$leased" | jq -r '.jobs[0].lease_token // empty')
  [ -z "$id" ] && continue                      # empty long-poll; lease again

  # Heartbeat in the background every 30s while the handler runs.
  ( while sleep 30; do
      status=$(curl -s -X POST "$BASE/api/v1/jobs/$id/heartbeat" -H "$AUTH" -H 'Content-Type: application/json' \
        -d "{\"lease_token\":\"$token\",\"extend_secs\":60}" | jq -r .status)
      [ "$status" != "running" ] && exit 0      # server owns the outcome now
    done ) & hb=$!

  if ./resize-image "$(echo "$leased" | jq -c '.jobs[0].job.payload')"; then
    curl -s -X POST "$BASE/api/v1/jobs/$id/complete" -H "$AUTH" -H 'Content-Type: application/json' \
      -d "{\"lease_token\":\"$token\",\"result\":{\"ok\":true}}"
  else
    curl -s -X POST "$BASE/api/v1/jobs/$id/fail" -H "$AUTH" -H 'Content-Type: application/json' \
      -d "{\"lease_token\":\"$token\",\"error\":\"resize failed\",\"retryable\":true}"
  fi
  kill $hb 2>/dev/null
done
```

A production worker adds: handling `409` and non-`running` heartbeat statuses by aborting the handler, surfacing `401`/`403` instead of spinning, backing off on transport errors, and concurrency across a leased batch.

## Rules that keep at-least-once honest

1. **Handlers must be idempotent.** The same job can be delivered twice: after a crash, after a lost heartbeat, or after a network error on `complete`.
2. **Heartbeat at half the lease, and heartbeat everything you hold.**
3. **Obey the heartbeat response.** A non-`running` status or a `409` means stop; do not report.
4. **Classify failures.** Send `retryable: false` for permanent errors.
5. **Use the worker token.** Never hand a tenant token to a worker.

## Using the SDK runtimes

```ts
// TypeScript: one call runs the whole loop with heartbeating and cancellation.
await qf.worker.run("images", {
  "resize-image": async (job, ctx) => {
    ctx.signal.throwIfAborted();
    return await resize(job.payload);
  },
}, { leaseSecs: 60, waitSecs: 20 });
```

```rust
// Rust: queueflow-client's Worker shares the server's own types.
Worker::new(client, "images", WorkerOptions::default())
    .register("resize-image", |job| async move { Ok(Map::new()) })
    .run()
    .await;
```

Python and Go expose `lease`, `heartbeat`, `complete`, and `fail` as typed calls; see their pages for the three rules restated in each language's terms.
