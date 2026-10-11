---
title: Dashboard
description: The web dashboard built into the QueueFlow server at /ui/, what it shows, which actions it offers, how it authenticates, and its limits.
---

Since 0.3.0 the server serves a web dashboard at `/ui/` on the API port, for example `http://localhost:8000/ui/`. It is embedded in the binary and needs no build step or extra service. It shows what the API exposes and, since 0.5.0, offers the API's administrative actions (cancel, replay, pause and resume) to read-write tokens, each behind a confirmation.

![The overview: per-queue backlog with the age of the oldest claimable job, and tenant-wide totals](/img/dashboard/overview.jpg)

## What it shows

- **Queues**: every queue the tenant has enqueued to, from `GET /api/v1/queues`, with its backlog (claimable, scheduled for later, running, and the age of the oldest claimable job) and whether it is paused, plus tenant-wide totals from `GET /api/v1/stats`. Refreshes every 5 seconds with a pause toggle.
- **Jobs**: filter by status, queue, task, and creation time; keyset paging, newest first. The detail view shows status, timestamps, config, payload and result as JSON, the error message, retry count and next retry, and a link to the owning workflow. A running job updates live over the job's SSE stream.

![The jobs list, filtered and paged, with status badges and retry counts](/img/dashboard/jobs.jpg)

![A running job's detail page: payload, config, timeline, and a live indicator](/img/dashboard/job-detail.jpg)
- **Workflows**: list with a status filter; the detail view draws the dependency graph with each step coloured by its state, plus a steps table and the shared context.

![A running workflow: the dependency graph with completed steps in green and the shipping step still running](/img/dashboard/workflow.jpg)

![A partially failed workflow: the failed step is red and the dependents that continued past it are shown](/img/dashboard/partially-failed.jpg)
- **Dead letters**: list and detail with the reason, error, and a link to the original job.

![The dead-letter list: reason, task, queue, error, and a link to the original job](/img/dashboard/dead-letters.jpg)
- **Cron**: every schedule with its expression, next run, last enqueue, and whether it is enabled.
- **Tasks**: the handlers registered in the server.

## Actions

With a read-write token (an ordinary API key or a JWT without `scope: read`) the dashboard shows action buttons; a read-only token sees the same pages without them, and the header names the tenant and access level (from `GET /api/v1/whoami`). Every action opens a confirmation that says what will happen before anything is sent.

| Where | Action | API call |
| --- | --- | --- |
| Overview, each queue | Pause / Resume | `POST /api/v1/queues/{queue}/pause` and `/resume`. Pausing stops claims of this tenant's jobs on the queue; running jobs finish, so the queue is drained once Running reaches zero. |
| Job page | Cancel job | `POST /api/v1/jobs/{id}/cancel` |
| Jobs list, with a `pending`, `retrying` or `running` status filter | Cancel matching jobs | `POST /api/v1/jobs/cancel` with the list's filters, up to 1000 jobs, oldest first. Run it again if the flash says more may remain. |
| Workflow page | Cancel workflow | `POST /api/v1/workflows/{id}/cancel` |
| Dead letters, each unreplayed entry and its page | Replay | `POST /api/v1/dlq/{id}/replay` |
| Cron, each schedule | Pause / Resume | `POST /api/v1/cron/{id}/pause` and `/resume` |

The dashboard never creates jobs, workflows or schedules; use the API or an SDK for that.

## Authentication

The dashboard asks for a bearer token once and keeps it in the browser's session storage, then calls the same-origin `/api/v1` endpoints with it. Use a **tenant** credential (an API key or JWT); the worker token is refused on these routes. Everything shown is scoped to that tenant. In `--dev` mode any non-empty token works.

A [read-only key](/concepts/auth#static-api-keys) (`viewer:acme:ro`, since 0.4.0) is the right credential to hand out for looking: it can see everything for its tenant and change nothing, even if someone takes it out of the browser and calls the API directly. Hand out a read-write key only to people who should be able to cancel, replay and pause; the server enforces the access level on every request whatever the browser shows.

The static files under `/ui/` are served without authentication and contain no data. They are not part of the OpenAPI document.

## Limits

- The dependency graph is rendered with Mermaid loaded from `cdn.jsdelivr.net` on demand. Without access to the CDN the Mermaid source is shown as text instead; the rest of the dashboard has no external dependencies.
- Queues are listed from the registry the engine fills as it enqueues (since 0.5.0). On a server upgraded from 0.4.0 or earlier, a queue appears once the first job is enqueued to it after the upgrade or while it still has non-terminal jobs.
- The SSE stream is consumed over `fetch` so the token can travel in a header; the browser's native `EventSource` cannot be used.
