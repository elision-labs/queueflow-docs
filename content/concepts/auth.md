---
title: Authentication and tenants
description: Tenant API keys, HS256 JWTs, the separate worker credential, the --dev flag and what development mode means, and how tenant isolation works.
---

Every `/api/v1` route requires `Authorization: Bearer <token>`. Which token depends on what the caller is: an **application** acting for one tenant, or a **worker** that executes work for every tenant. The probe endpoints `/health` and `/ready`, the Swagger UI at `/docs`, and `/openapi.json` need no token.

## Tenant credentials

A tenant is a string id. Every job, workflow, cron schedule, and dead letter carries a `tenant_id`, and every tenant-facing read and write is scoped to the caller's tenant: a job owned by another tenant is a `403`. Idempotency keys and cron schedule names are unique per tenant, not globally.

Two ways to authenticate as a tenant can be enabled, separately or together.

### Static API keys

```bash
queueflow serve --api-keys "k_acme_9f3a:acme,k_globex_c21d:globex"
```

Each entry is `token:tenant`. The token is sent as the bearer value and maps to that tenant. Keys are read at startup, so rotating one means restarting the server. Good for a small, fixed set of internal services.

Since 0.4.0 a third field makes a key **read-only**:

```bash
queueflow serve --api-keys "k_acme_9f3a:acme,viewer_acme_7b1e:acme:ro"
```

A read-only key may call every `GET` route for its tenant, including the SSE job stream and the [dashboard](/dashboard), and receives `403` on anything that writes (`POST` and `DELETE`). The check runs in the auth middleware before any handler, so a refused write has no side effects. Use read-only keys for dashboards, support staff, and status pages; `:rw` is accepted as an explicit spelling of the default.

### HS256 JWTs

```bash
queueflow serve --jwt-secret "$(openssl rand -hex 32)"
```

Any token that verifies with the secret is accepted. The `sub` claim is the tenant id and `exp` is enforced. This lets you mint short-lived tenant tokens from your own auth service without touching the QueueFlow configuration.

```python
import jwt, time
token = jwt.encode({"sub": "acme", "exp": int(time.time()) + 3600}, SECRET, algorithm="HS256")
```

A JWT can be read-only too (since 0.4.0): add a `scope` claim. A space-separated scope list that names `read` and not `write` makes the token read-only; no `scope` claim, or one that includes `write`, keeps full access.

```python
viewer = jwt.encode({"sub": "acme", "exp": int(time.time()) + 3600, "scope": "read"}, SECRET, algorithm="HS256")
```

Only HS256 is supported today; asymmetric keys and JWKS are on the roadmap.

## The worker credential

Worker-protocol routes (`/api/v1/queues/{queue}/lease`, and `/heartbeat`, `/complete`, `/fail` under `/api/v1/jobs/{id}`) execute arbitrary tenants' jobs and see their payloads. They require a separate credential:

```bash
queueflow serve --worker-token "$(openssl rand -hex 32)"
```

Workers send this value as their bearer token. A tenant token on a worker route is a `403` ("authenticated, but not with the worker credential"), and the worker token on a tenant route is unauthorized. Keep the two kinds of secret in different places.

## Fail-closed startup

`queueflow serve` in `api` or `all` mode refuses to start unless tenant authentication (`--api-keys` and/or `--jwt-secret`) **and** `--worker-token` are configured, or `--dev` is passed. A missing credential is a startup error, not a server that silently accepts everything. `--mode worker` has no HTTP listener other than metrics and is not subject to the check.

## Development mode

`queueflow serve --dev` (or the environment variable `QUEUEFLOW_DEV=1`) replaces the credential checks with development placeholders:

- Any non-empty bearer token authenticates as the fixed tenant `tenant1`, so `-H 'Authorization: Bearer dev'` works everywhere.
- The worker routes accept any authenticated caller; a worker can lease and report with the same `dev` token.
- The server warns loudly about both at startup.

This is convenient on a laptop and dangerous anywhere else. `--dev` is for the [quick start](/quickstart), local development, and test suites. Never set it in production, and never expose a `--dev` server to a network you do not control. The flag is not a partial hardening step: to leave development mode, drop it and configure all three credentials. See the [deployment checklist](/deployment#security-checklist).

The SDKs reflect the same split. Each has a way to pass a separate worker credential (`workerToken` in TypeScript, `worker_token=` in Python, `Options.WorkerToken` in Go, `QueueFlowOptions::worker_token` in Rust); when it is omitted, the tenant token is reused on worker routes, which only works against a `--dev` server.

## Putting it together

```bash
queueflow serve \
  --api-keys "k_acme_9f3a:acme" \
  --jwt-secret "$QUEUEFLOW_JWT_SECRET" \
  --worker-token "$QUEUEFLOW_WORKER_TOKEN" \
  --cors-origins "https://app.example.com"
```

```ts
// Application side: a tenant token.
const qf = new QueueFlow({ baseUrl, token: process.env.QUEUEFLOW_TOKEN });

// Worker side: the same client, with the worker credential for worker routes.
const worker = new QueueFlow({ baseUrl, token: process.env.QUEUEFLOW_TOKEN, workerToken: process.env.QUEUEFLOW_WORKER_TOKEN });
await worker.worker.run("emails", handlers);
```

The TypeScript SDK's `workerToken` option, the Python facade's `worker_token=` argument, the Go SDK's `Options.WorkerToken`, and the Rust SDK's `QueueFlowOptions::worker_token` all exist for exactly this split.

## Transport security

The server speaks plain HTTP. Terminate TLS in front of it (a load balancer, an ingress, or a reverse proxy) and keep the API off the public internet unless every credential is configured. CORS is permissive until `--cors-origins` is set.

## What isolation covers

| Scope | Isolated per tenant |
| --- | --- |
| Jobs: create, get, list, cancel, events | yes |
| Workflows: create, get, list, steps, diagram, cancel | yes |
| Cron schedules | yes; names are unique per tenant |
| Dead letters: list, get, replay | yes |
| Idempotency keys | yes; the same key in two tenants is two jobs |
| `GET /api/v1/stats` | yes; job and workflow counts for the caller's tenant |
| `GET /api/v1/tasks` | no; handlers are registered per deployment, not per tenant |
| Worker routes | no; workers see every tenant's jobs on the queue |

Rate limiting and per-tenant quotas are on the roadmap.
