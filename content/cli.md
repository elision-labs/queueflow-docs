---
title: CLI
description: The queueflow binary doubles as a client for a running server. Create and inspect jobs, workflows, dead letters, and cron schedules from the shell.
---

The same `queueflow` binary that runs the server is a command-line client for one. Install it as described in [Installation](/installation), or run it from the Docker image.

## Connecting

Client subcommands read two settings:

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--server-url` | `QUEUEFLOW_SERVER_URL` | `http://localhost:8000` |
| `--token` | `QUEUEFLOW_TOKEN` | `dev` |

```bash
export QUEUEFLOW_SERVER_URL=https://queue.internal.example.com
export QUEUEFLOW_TOKEN=k_acme_9f3a
```

Output is JSON, so the CLI composes with `jq`.

## Commands

### Server

| Command | Description |
| --- | --- |
| `queueflow serve [flags]` | Run the API server and/or workers. See [Configuration](/configuration). |
| `queueflow migrate --database-url …` | Apply database migrations and exit. |
| `queueflow spec [--output-dir spec]` | Write `openapi.json` and `openapi.yaml`, generated from the handlers, to a directory. |

### Jobs

| Command | Description |
| --- | --- |
| `queueflow job create --task <name> [--payload '{…}'] [--queue q] [--max-retries n] [--timeout-secs n] [--idempotency-key k] [--run-at 2026-06-09T15:00:00Z] [--wait]` | Enqueue a job and print its id. `--wait` blocks until the job is terminal and prints the full record. With `--idempotency-key`, re-running the command returns the same job. |
| `queueflow job get <id>` | Fetch one job. |
| `queueflow job list [--status s] [--queue q] [--task t] [--limit n] [--offset n] [--include-total]` | List jobs. |
| `queueflow job cancel <id>` | Cancel a job. |
| `queueflow job cancel-many [--queue q] [--task t] [--status pending\|retrying\|running] [--created-before <rfc3339>] [--limit 100]` | Cancel every matching non-terminal job, oldest first, up to the limit; prints the count. Since 0.5.0. |
| `queueflow job watch <id> [--timeout-secs 600]` | Wait for a job to finish and print it. |

### Workflows

| Command | Description |
| --- | --- |
| `queueflow workflow create --file <path>` | Create a workflow from a JSON `CreateWorkflowRequest` (`-` reads stdin) and print its id. |
| `queueflow workflow get <id>` | Fetch one workflow. |
| `queueflow workflow list [--status s] [--limit n] [--offset n] [--include-total]` | List workflows. |
| `queueflow workflow cancel <id>` | Cancel a workflow and its unscheduled steps. |
| `queueflow workflow retry <id>` | Re-run a failed, partially failed or cancelled workflow from its unfinished steps. Since 0.6.0. |
| `queueflow workflow steps <id>` | Print every step's live state (status, job, error, timestamps, fan-out progress, child workflow). Since 0.6.0. |
| `queueflow workflow diagram <id>` | Print the DAG as a Mermaid document. |

### Dead letters

| Command | Description |
| --- | --- |
| `queueflow dlq list [--queue q] [--limit n] [--offset n] [--include-total]` | List dead letters, newest first. |
| `queueflow dlq get <id>` | Fetch one dead letter (integer id). |
| `queueflow dlq replay <id>` | Replay a dead letter as a fresh job and print the new job id. |
| `queueflow dlq replay-many [--queue q] [--task t] [--limit 100]` | Replay every unreplayed matching dead letter, oldest first; prints one outcome per entry. Since 0.5.0. |

### Cron

| Command | Description |
| --- | --- |
| `queueflow cron create --name <n> --schedule "*/5 * * * *" --task <t> [--payload '{…}'] [--queue q]` | Create a schedule (UTC) and print its id. |
| `queueflow cron list [--limit n] [--offset n] [--include-total]` | List schedules. |
| `queueflow cron get <id>` | Fetch one schedule. |
| `queueflow cron delete <id>` | Delete a schedule; already-enqueued jobs are unaffected. |
| `queueflow cron pause <id>` · `queueflow cron resume <id>` | Stop firings, or resume at the next future occurrence. |

### Introspection

| Command | Description |
| --- | --- |
| `queueflow queue list` | List the tenant's queues with their backlog and `paused` flag. Since 0.5.0. |
| `queueflow queue pause <name>` · `queueflow queue resume <name>` | Stop or resume claims of the tenant's jobs on a queue; prints the live counts (drained once `running` is 0). Since 0.5.0. |
| `queueflow tasks` | List the task handlers registered in the server. |
| `queueflow stats` | Show job and workflow counters for the token's tenant. |
| `queueflow whoami` | Show the tenant and access level of the token. Since 0.5.0. |

## Examples

```bash
# Enqueue and wait, idempotently
queueflow job create --task echo --payload '{"hello":"world"}' --idempotency-key hello-1 --wait

# Schedule for later
queueflow job create --task send_digest --run-at 2026-10-07T08:00:00Z

# What is waiting on backoff?
queueflow job list --status retrying | jq '.jobs[] | {id, task_name, retry_count, next_retry_at}'

# Create a workflow from a file and render its diagram
queueflow workflow create --file etl.json
queueflow workflow diagram <id>

# Triage and replay dead letters
queueflow dlq list | jq '.dead_letters[] | {id, task_name, reason, error_message}'
queueflow dlq replay 17

# Regenerate the OpenAPI document from the binary
queueflow spec --output-dir ./spec
```

```json
// etl.json
{
  "name": "etl",
  "steps": [
    { "name": "extract",   "task_name": "echo" },
    { "name": "transform", "task_name": "echo", "depends_on": ["extract"] },
    { "name": "load",      "task_name": "echo", "depends_on": ["transform"] }
  ]
}
```

## From the Docker image

```bash
docker run --rm -e QUEUEFLOW_SERVER_URL=http://host.docker.internal:8000 -e QUEUEFLOW_TOKEN=dev \
  ghcr.io/elision-labs/queueflow:0.6 job list --limit 5
```
