---
title: Dashboard
description: The read-only web dashboard built into the QueueFlow server at /ui/, what it shows, how it authenticates, and its limits.
---

Since 0.3.0 the server serves a web dashboard at `/ui/` on the API port, for example `http://localhost:8000/ui/`. It is embedded in the binary, needs no build step or extra service, and is read-only: it shows what the API exposes and performs no actions.

![The overview: per-queue backlog with the age of the oldest claimable job, and tenant-wide totals](/img/dashboard/overview.jpg)

## What it shows

- **Queues**: per-queue backlog from `GET /api/v1/queues` (claimable, scheduled for later, running, and the age of the oldest claimable job), with tenant-wide totals from `GET /api/v1/stats`. Refreshes every 5 seconds with a pause toggle.
- **Jobs**: filter by status, queue, and creation time; keyset paging, newest first. The detail view shows status, timestamps, config, payload and result as JSON, the error message, retry count and next retry, and a link to the owning workflow. A running job updates live over the job's SSE stream.

![The jobs list, filtered and paged, with status badges and retry counts](/img/dashboard/jobs.jpg)

![A running job's detail page: payload, config, timeline, and a live indicator](/img/dashboard/job-detail.jpg)
- **Workflows**: list with a status filter; the detail view draws the dependency graph with each step coloured by its state, plus a steps table and the shared context.

![A running workflow: the dependency graph with completed steps in green and the shipping step still running](/img/dashboard/workflow.jpg)

![A partially failed workflow: the failed step is red and the dependents that continued past it are shown](/img/dashboard/partially-failed.jpg)
- **Dead letters**: list and detail with the reason, error, and a link to the original job.

![The dead-letter list: reason, task, queue, error, and a link to the original job](/img/dashboard/dead-letters.jpg)
- **Cron**: every schedule with its expression, next run, last enqueue, and whether it is enabled.
- **Tasks**: the handlers registered in the server.

## Authentication

The dashboard asks for a bearer token once and keeps it in the browser's session storage, then calls the same-origin `/api/v1` endpoints with it. Use a **tenant** credential (an API key or JWT); the worker token is refused on these routes. Everything shown is scoped to that tenant. In `--dev` mode any non-empty token works.

Because the dashboard only reads, a [read-only key](/concepts/auth#static-api-keys) (`viewer:acme:ro`, since 0.4.0) is the right credential to hand out for it: it can see everything for its tenant and change nothing, even if someone takes it out of the browser and calls the API directly.

The static files under `/ui/` are served without authentication and contain no data. They are not part of the OpenAPI document.

## Limits

- Read-only. Cancel, replay, pause, and resume are planned for a later release and will sit behind a confirmation.
- The dependency graph is rendered with Mermaid loaded from `cdn.jsdelivr.net` on demand. Without access to the CDN the Mermaid source is shown as text instead; the rest of the dashboard has no external dependencies.
- Queues disappear from the overview once all their jobs are terminal, because `GET /api/v1/queues` reports only queues with non-terminal jobs.
- The SSE stream is consumed over `fetch` so the token can travel in a header; the browser's native `EventSource` cannot be used.
