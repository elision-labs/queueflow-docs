---
title: Dashboard
description: The read-only web dashboard built into the QueueFlow server at /ui/, what it shows, how it authenticates, and its limits.
---

Since 0.3.0 the server serves a web dashboard at `/ui/` on the API port, for example `http://localhost:8000/ui/`. It is embedded in the binary, needs no build step or extra service, and is read-only: it shows what the API exposes and performs no actions.

## What it shows

- **Queues**: per-queue backlog from `GET /api/v1/queues` (claimable, scheduled for later, running, and the age of the oldest claimable job), with tenant-wide totals from `GET /api/v1/stats`. Refreshes every 5 seconds with a pause toggle.
- **Jobs**: filter by status, queue, and creation time; keyset paging, newest first. The detail view shows status, timestamps, config, payload and result as JSON, the error message, retry count and next retry, and a link to the owning workflow. A running job updates live over the job's SSE stream.
- **Workflows**: list with a status filter; the detail view draws the dependency graph with each step coloured by its state, plus a steps table and the shared context.
- **Dead letters**: list and detail with the reason, error, and a link to the original job.
- **Cron**: every schedule with its expression, next run, last enqueue, and whether it is enabled.
- **Tasks**: the handlers registered in the server.

## Authentication

The dashboard asks for a bearer token once and keeps it in the browser's session storage, then calls the same-origin `/api/v1` endpoints with it. Use a **tenant** credential (an API key or JWT); the worker token is refused on these routes. Everything shown is scoped to that tenant. In `--dev` mode any non-empty token works.

The static files under `/ui/` are served without authentication and contain no data. They are not part of the OpenAPI document.

## Limits

- Read-only. Cancel, replay, pause, and resume are planned for a later release and will sit behind a confirmation.
- The dependency graph is rendered with Mermaid loaded from `cdn.jsdelivr.net` on demand. Without access to the CDN the Mermaid source is shown as text instead; the rest of the dashboard has no external dependencies.
- Queues disappear from the overview once all their jobs are terminal, because `GET /api/v1/queues` reports only queues with non-terminal jobs.
- The SSE stream is consumed over `fetch` so the token can travel in a header; the browser's native `EventSource` cannot be used.
