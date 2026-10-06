---
title: Authentication and tenants
description: Tenant API keys, HS256 JWTs, the separate worker credential, what development mode means, and how tenant isolation works.
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

### HS256 JWTs

```bash
queueflow serve --jwt-secret "$(openssl rand -hex 32)"
```

Any token that verifies with the secret is accepted. The `sub` claim is the tenant id and `exp` is enforced. This lets you mint short-lived tenant tokens from your own auth service without touching the QueueFlow configuration.

```python
import jwt, time
token = jwt.encode({"sub": "acme", "exp": int(time.time()) + 3600}, SECRET, algorithm="HS256")
```

Only HS256 is supported today; asymmetric keys and JWKS are on the roadmap.

## The worker credential

Worker-protocol routes (`/api/v1/queues/{queue}/lease`, and `/heartbeat`, `/complete`, `/fail` under `/api/v1/jobs/{id}`) execute arbitrary tenants' jobs and see their payloads. They require a separate credential:

```bash
queueflow serve --worker-token "$(openssl rand -hex 32)"
```

Workers send this value as their bearer token. A tenant token on a worker route is a `403` ("authenticated, but not with the worker credential"), and the worker token on a tenant route is unauthorized. Keep the two kinds of secret in different places.

## Development mode

With **neither** `--api-keys` nor `--jwt-secret` set, any non-empty bearer token authenticates as the fixed tenant `tenant1`. With **no** `--worker-token`, any authenticated caller may lease and report work. The server warns loudly about each at startup. This is convenient on a laptop (`-H 'Authorization: Bearer dev'`) and dangerous anywhere else.

The checks are independent: you can configure real tenant auth and still leave the worker routes open, or the reverse. Configure all three flags in production. See the [deployment checklist](/deployment#security-checklist).

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

The TypeScript SDK's `workerToken` option, the Python facade's `worker_token=` argument, and the Rust and Go clients' second configuration all exist for exactly this split.

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
| `GET /api/v1/stats`, `GET /api/v1/tasks` | no; process-wide introspection |
| Worker routes | no; workers see every tenant's jobs on the queue |

Rate limiting and per-tenant quotas are on the roadmap.
