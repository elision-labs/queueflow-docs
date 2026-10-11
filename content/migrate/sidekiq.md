---
title: Migrating from Sidekiq
description: A concept map and side-by-side code for moving Ruby background jobs from Sidekiq on Redis to QueueFlow on PostgreSQL. There is no Ruby SDK yet; the REST API and the worker protocol are the path.
---

Sidekiq is a Ruby job processor backed by Redis, with jobs defined as classes that include `Sidekiq::Job`. QueueFlow is a separate server backed by PostgreSQL that any language reaches over HTTP.

> **Note**
> There is no Ruby SDK for QueueFlow yet. The path from Ruby is the [REST API](/api) for enqueuing and reading jobs, and the [worker protocol](/concepts/workers) (lease, heartbeat, complete, fail) for executing them. Both are small enough to call with `Net::HTTP`, and the server ships an OpenAPI 3.1 document (`/openapi.json`) from which openapi-generator can produce a Ruby client. The examples below use only the standard library.

The server version is 0.2.0.

## Concept mapping

| Sidekiq | QueueFlow | Notes |
| --- | --- | --- |
| Job class including `Sidekiq::Job` | `task_name` plus a handler in your worker loop | Dispatch on `task_name` yourself. |
| `perform(*args)` | Handler receiving `payload` | JSON object, not positional args. |
| `MyJob.perform_async(*args)` | `POST /api/v1/jobs` | Returns `{"job_id": …}`. |
| `perform_in(interval)` / `perform_at(time)` | `run_at` (RFC 3339) | A row with a future `scheduled_at`. |
| `sidekiq_options queue: 'critical'` | `"config": {"queue": "critical"}` | Queues are implicit. |
| Queue weights (`-q critical,2 -q default`) | One worker loop per queue | A worker leases from one queue at a time; QueueFlow orders within a queue by `priority`. |
| `sidekiq_options retry: 5` (default 25) | `"config": {"max_retries": 5}` (default 3) | Both count retries after the first attempt. |
| Retry backoff `(retry_count ** 4) + 15 + rand(10) * (retry_count + 1)` | `retry_backoff`, `retry_delay_secs`, `retry_max_delay_secs`, `jitter_factor` | Configurable per job. |
| `sidekiq_retry_in` block returning `:kill` | `"retryable": false` on `/fail` | Dead-letters immediately. |
| `retry: false` / `:discard` | Not available | Every failed job is recorded; see [DLQ](#the-dead-set-versus-the-dead-letter-queue). |
| The Dead set | The dead-letter queue | Different retention and replay rules. |
| `sidekiq_options unique_for:` (Enterprise) | `Idempotency-Key` header | Different semantics; see [Idempotency](#idempotency-unique-jobs-versus-idempotency-key). |
| Sidekiq Enterprise periodic jobs, or `sidekiq-cron` | `POST /api/v1/cron` | Built in, UTC crontab. |
| Sidekiq Pro batches | Workflows (`POST /api/v1/workflows`) | Static DAG with `depends_on`. |
| Sidekiq Web | No dashboard yet (in progress) | Use the API, the `queueflow` CLI, or SQL. |
| Redis 7.0+ (or Valkey, Dragonfly) | PostgreSQL 13 or newer, no extensions | |

## Enqueue

```ruby
# Sidekiq
class WelcomeEmailJob
  include Sidekiq::Job
  sidekiq_options queue: 'emails', retry: 3

  def perform(to)
    Mailer.welcome(to).deliver_now
  end
end

WelcomeEmailJob.perform_async('ada@example.com')
WelcomeEmailJob.perform_in(5.minutes, 'ada@example.com')
```

```ruby
# QueueFlow, from Ruby's standard library
require 'net/http'
require 'json'
require 'time'

BASE  = URI(ENV.fetch('QUEUEFLOW_URL', 'http://localhost:8000'))
TOKEN = ENV.fetch('QUEUEFLOW_TOKEN')      # a tenant API key or JWT

def qf_post(path, body, headers = {})
  req = Net::HTTP::Post.new(path, { 'Authorization' => "Bearer #{TOKEN}", 'Content-Type' => 'application/json' }.merge(headers))
  req.body = JSON.generate(body)
  res = Net::HTTP.start(BASE.host, BASE.port) { |http| http.request(req) }
  raise "#{res.code}: #{res.body}" unless res.is_a?(Net::HTTPSuccess)
  res.body.empty? ? nil : JSON.parse(res.body)
end

qf_post('/api/v1/jobs', {
  task_name: 'welcome_email',
  payload:   { to: 'ada@example.com' },
  config:    { queue: 'emails', max_retries: 3 }
})
# => {"job_id"=>"3f1c…"}

qf_post('/api/v1/jobs', {
  task_name: 'welcome_email',
  payload:   { to: 'ada@example.com' },
  config:    { queue: 'emails', max_retries: 3 },
  run_at:    (Time.now.utc + 300).iso8601
})
```

The request body is a `CreateJobRequest`; see the [REST API reference](/api) for every field. `POST /api/v1/jobs/batch` takes up to 1000 jobs in one call and is the equivalent of `Sidekiq::Client.push_bulk`.

## Worker

A Sidekiq process is started with `bundle exec sidekiq -q emails` and finds job classes by name. A QueueFlow worker is a loop you run: lease, heartbeat while working, then complete or fail. The shell version is on the [Remote workers](/concepts/workers#writing-a-worker-from-scratch) page; here it is in Ruby.

```ruby
require 'net/http'
require 'json'

BASE         = URI(ENV.fetch('QUEUEFLOW_URL', 'http://localhost:8000'))
WORKER_TOKEN = ENV.fetch('QUEUEFLOW_WORKER_TOKEN')   # the server's --worker-token, not a tenant token
LEASE_SECS   = 60

HANDLERS = {
  'welcome_email' => ->(payload) { Mailer.welcome(payload['to']).deliver_now; { 'sent' => true } }
}

def worker_post(http, path, body)
  req = Net::HTTP::Post.new(path, 'Authorization' => "Bearer #{WORKER_TOKEN}", 'Content-Type' => 'application/json')
  req.body = JSON.generate(body)
  res = http.request(req)
  [res.code.to_i, res.body.to_s.empty? ? nil : JSON.parse(res.body)]
end

Net::HTTP.start(BASE.host, BASE.port) do |http|
  http.read_timeout = 60
  loop do
    code, leased = worker_post(http, '/api/v1/queues/emails/lease', { max_jobs: 1, lease_secs: LEASE_SECS, wait_secs: 20 })
    raise "lease failed: #{code}" if [401, 403].include?(code)   # wrong credential: do not spin
    next if code != 200 || leased['jobs'].empty?

    job   = leased['jobs'][0]['job']
    token = leased['jobs'][0]['lease_token']
    id    = job['id']

    # Heartbeat at half the lease interval; stop if the server no longer says "running".
    alive = true
    hb = Thread.new do
      Net::HTTP.start(BASE.host, BASE.port) do |hb_http|
        while alive
          sleep LEASE_SECS / 2
          code, body = worker_post(hb_http, "/api/v1/jobs/#{id}/heartbeat", { lease_token: token, extend_secs: LEASE_SECS })
          if code != 200 || body['status'] != 'running'
            alive = false            # lease lost or job cancelled: the server owns the outcome now
          end
        end
      end
    end

    handler = HANDLERS[job['task_name']]
    begin
      if handler.nil?
        worker_post(http, "/api/v1/jobs/#{id}/fail", { lease_token: token, error: "no handler for #{job['task_name']}", retryable: false })
      else
        result = handler.call(job['payload'])
        worker_post(http, "/api/v1/jobs/#{id}/complete", { lease_token: token, result: result || {} }) if alive
      end
    rescue ArgumentError => e          # your "permanent error" class
      worker_post(http, "/api/v1/jobs/#{id}/fail", { lease_token: token, error: e.message, retryable: false }) if alive
    rescue StandardError => e
      worker_post(http, "/api/v1/jobs/#{id}/fail", { lease_token: token, error: e.message, retryable: true }) if alive
    ensure
      alive = false
      hb.join
    end
  end
end
```

The rules this loop follows are the same ones every SDK runtime implements:

1. Worker routes take the **worker token**. A tenant token there is a `403`; treat `401`/`403` as fatal rather than retrying.
2. Heartbeat every job you hold at about half its lease, and stop reporting when a heartbeat answers anything other than `running` or returns `409`.
3. Report permanent errors with `retryable: false`.
4. Handlers must be idempotent.

Run one copy of the loop per queue and as many processes as you need; claims are serialized by `FOR UPDATE SKIP LOCKED` so they never double-claim.

## Retries and backoff

Sidekiq retries 25 times by default over about 20 days with the delay `(retry_count ** 4) + 15 + (rand(10) * (retry_count + 1))` seconds, configurable with `sidekiq_options retry:` and `sidekiq_retry_in`. QueueFlow retries 3 times by default with exponential backoff, `retry_delay_secs * 2^n` capped at `retry_max_delay_secs` (3600 by default) and jittered by `jitter_factor` (0.1 by default), all set per job:

```ruby
qf_post('/api/v1/jobs', {
  task_name: 'charge_payment',
  payload:   { order_id: 'o_123' },
  config:    { max_retries: 6, retry_backoff: 'exponential', retry_delay_secs: 30, retry_max_delay_secs: 3600, jitter_factor: 0.2 }
})
```

`fixed` and `linear` are also available. There is no per-class hook like `sidekiq_retry_in`; the policy is data on the job, and the server computes the next attempt. To skip retries for a permanent error, fail with `retryable: false` where you would have returned `:kill`. See [Retries, timeouts and the DLQ](/concepts/retries#backoff).

## Scheduled and recurring jobs

`perform_in` and `perform_at` map to `run_at`, shown above. Sidekiq's scheduler polls Redis roughly every 5 seconds; QueueFlow's scheduled job is a row whose `scheduled_at` is in the future and becomes claimable at that instant.

Open-source Sidekiq has no recurring jobs; they come from Sidekiq Enterprise periodic jobs or a gem such as `sidekiq-cron`. QueueFlow's cron is built in:

```ruby
# sidekiq-cron
Sidekiq::Cron::Job.create(name: 'nightly report', cron: '0 2 * * *', class: 'BuildReportJob')
```

```ruby
# QueueFlow
schedule = qf_post('/api/v1/cron', {
  name:      'nightly-report',
  cron_expr: '0 2 * * *',          # UTC
  task_name: 'build_report',
  payload:   { format: 'pdf' },
  queue:     'reports'
})
# => {"cron_id"=>"c_7f…"}

qf_post("/api/v1/cron/#{schedule['cron_id']}/pause", {})
qf_post("/api/v1/cron/#{schedule['cron_id']}/resume", {})
```

Expressions are UTC only. Every `worker`- or `all`-mode server process runs the scheduler and firings are deduplicated, so there is no single-scheduler process to keep alive. A long outage collapses into one catch-up firing. See [Cron schedules](/concepts/cron).

## Semantic differences that matter

### Delivery guarantees

Open-source Sidekiq fetches with `BRPOP`, which removes the job from Redis before it runs; in Sidekiq's own words, if the process crashes while processing that job "it is lost forever". On a clean restart Sidekiq tries to push unfinished jobs back. Durable fetch (`super_fetch`) is a Sidekiq Pro feature.

QueueFlow is at-least-once everywhere. A claimed job stays in the table as `running` with a lease; if the worker dies, the janitor (sweeping every 5 seconds) reclaims it once the lease expires and routes it through the retry policy. The cost is that the handler can run twice, so handlers that were safe under Sidekiq's at-most-once behaviour need to become idempotent.

### Lease tokens

Sidekiq has no lease: a job in flight belongs to whoever popped it. QueueFlow hands each claim a `lease_token`, regenerated on every claim, and requires it on every heartbeat, complete, and fail. If the lease expired and the job was reclaimed, the old token gets a `409`, so a worker that stalled and came back cannot overwrite a job that has since been retried, completed elsewhere, or cancelled. Each reclaim consumes one unit of retry budget (`delivery_count` exceeds `retry_count + 1` on the job), which is what stops a crashing handler from looping.

### The Dead set versus the dead-letter queue

Sidekiq moves a job that exhausts its retries to the Dead set, capped at 10,000 jobs or 6 months by default, from which Sidekiq Web can retry it in place. `retry: false` or `:discard` throws the job away.

QueueFlow marks the job `failed` and writes a dead-letter entry with a `reason` (`max_attempts_exceeded`, `non_retryable`, or `handler_not_found`) and the last `error_message`. There is no discard option; every failure is recorded. `GET /api/v1/dlq` lists entries, and `POST /api/v1/dlq/{id}/replay` creates a **fresh job** with the same task, payload, queue, and config and a full retry budget. Each entry replays at most once (`409` on the second attempt). Dead letters are kept forever unless `--retention-hours` is set. See [The dead-letter queue](/concepts/retries#the-dead-letter-queue).

### Idempotency: unique jobs versus `Idempotency-Key`

Sidekiq Enterprise's `unique_for:` locks on `(class, args, queue)` for a period, by default until the job succeeds, and the docs call it best effort. QueueFlow has no uniqueness lock. Its `Idempotency-Key` header, scoped to the tenant, makes **creation** idempotent: a second `POST /api/v1/jobs` with the same key returns the original job id with a `201`, for as long as the original row exists. It is the right tool for a retrying HTTP client or an at-least-once consumer that might submit the same request twice; it does not stop a second job with the same arguments and a different key, and it does not prevent a job from running twice after a crash.

### Time limits

Sidekiq has no per-job timeout. QueueFlow's `timeout` applies to in-process Rust handlers only; a Ruby handler is bounded by its lease and heartbeat. Enforce your own deadline inside the handler if you need one.

### Multi-tenancy and credentials

Sidekiq has one Redis namespace and no notion of callers. QueueFlow authenticates every request: tenant tokens (API keys or HS256 JWTs) for creating and reading jobs, and a separate worker token for the worker routes. Jobs, workflows, schedules, and dead letters are isolated per tenant. See [Authentication and tenants](/concepts/auth).

### What Sidekiq has that QueueFlow does not

- A Ruby SDK and `ActiveJob` integration. Until a Ruby client exists you write the HTTP calls or generate a client from the OpenAPI document.
- Sidekiq Web. QueueFlow's dashboard is in progress.
- Queue weights and strict queue ordering inside one process; QueueFlow workers lease from one queue each.
- Server and client middleware.
- Sidekiq Pro and Enterprise features such as batches with callbacks, rate limiting, and unique jobs. QueueFlow's workflows cover the batch-with-callback shape as a static DAG; rate limiting is on the roadmap.
- Redis throughput. Sidekiq's bottleneck is Redis I/O; QueueFlow's drain rate plateaus around 3,000 no-op jobs per second on one Postgres (see [Benchmarks](/benchmarks)), which is plenty for jobs that do real work and not enough for millisecond no-ops at very high volume.

## Checklist

1. Start a server with real credentials (`--api-keys` or `--jwt-secret`, plus `--worker-token`); see [Installation](/installation).
2. Wrap `POST /api/v1/jobs` in a small helper (or generate a client from `/openapi.json`) and replace `perform_async` / `perform_in` / `perform_at`, turning positional args into a payload hash.
3. Write one worker loop per queue that dispatches on `task_name`, heartbeats, and reports with the worker token.
4. Move `retry:` settings into per-job `config`, and fail with `retryable: false` for permanent errors.
5. Replace Enterprise periodic jobs or `sidekiq-cron` entries with `POST /api/v1/cron`, converting to UTC.
6. Audit handlers for idempotency; QueueFlow will redeliver after a crash where Sidekiq would have dropped the job.

## Sources

Sidekiq documentation, checked 2026-10-10:

- <https://github.com/sidekiq/sidekiq> (README: Redis 7.0+, Valkey, Dragonfly)
- <https://github.com/sidekiq/sidekiq/wiki/Getting-Started> (job class, `perform_async`)
- <https://github.com/sidekiq/sidekiq/wiki/Advanced-Options> (`sidekiq_options`, queue weights)
- <https://github.com/sidekiq/sidekiq/wiki/Error-Handling> (25 retries, backoff formula, Dead set limits, `sidekiq_retry_in`)
- <https://github.com/sidekiq/sidekiq/wiki/Scheduled-Jobs> (`perform_in`, `perform_at`, poll interval, Enterprise periodic jobs)
- <https://github.com/sidekiq/sidekiq/wiki/Reliability> (`BRPOP`, jobs lost on crash, `super_fetch`)
- <https://github.com/sidekiq/sidekiq/wiki/Ent-Unique-Jobs> (`unique_for`, `unique_until`)
- <https://github.com/sidekiq-cron/sidekiq-cron> (`Sidekiq::Cron::Job.create`)
