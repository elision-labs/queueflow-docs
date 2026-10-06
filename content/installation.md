---
title: Installation
description: Install the QueueFlow server as a prebuilt binary, a crate, a Docker image, or from source, and point it at PostgreSQL.
---

The server, the in-process workers, the migrations, and the CLI client all ship in one binary called `queueflow`. Pick whichever distribution fits your environment.

## Requirements

- **PostgreSQL 13 or newer.** Plain Postgres; no extensions. RDS, Cloud SQL, Azure Database, Neon, Supabase, or a local container all work. The server needs a role that can create a schema named `queueflow` and tables in it.
- **Rust 1.96 or newer** only if you build from source or use `cargo install`.
- **Docker** only if you use the image or run the opt-in spec validation and SDK generation in the repository.

## Prebuilt binaries

Every [GitHub release](https://github.com/elision-labs/queueflow-core/releases) attaches a tarball per platform plus the OpenAPI document. For v0.1.0:

| Asset | Platform |
| --- | --- |
| `queueflow-aarch64-apple-darwin.tar.gz` | macOS on Apple silicon |
| `queueflow-x86_64-unknown-linux-gnu.tar.gz` | Linux x86-64 (glibc) |
| `openapi.json`, `openapi.yaml` | The API spec this release serves |

```bash
curl -fsSL -o queueflow.tar.gz \
  https://github.com/elision-labs/queueflow-core/releases/download/v0.1.0/queueflow-x86_64-unknown-linux-gnu.tar.gz
tar -xzf queueflow.tar.gz
sudo install -m 0755 queueflow /usr/local/bin/queueflow
queueflow --version
```

## With cargo

```bash
cargo install queueflow
```

This builds the `queueflow` crate from crates.io with the PostgreSQL adapter enabled.

## Docker image

The image is published to GitHub Container Registry. Its entrypoint is the `queueflow` binary, so the container command is just the subcommand and flags:

```bash
docker pull ghcr.io/elision-labs/queueflow:0.1

docker run --rm -p 8000:8000 -p 9090:9090 \
  -e DATABASE_URL=postgres://user:pass@db.example.internal:5432/queueflow \
  ghcr.io/elision-labs/queueflow:0.1 serve --mode all --workers 10
```

Pin the minor tag (`0.1`) in production. A minimal Docker Compose file that brings up Postgres and the engine together:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: queueflow
      POSTGRES_PASSWORD: queueflow
      POSTGRES_DB: queueflow
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U queueflow"]
      interval: 2s
      timeout: 2s
      retries: 30

  queueflow:
    image: ghcr.io/elision-labs/queueflow:0.1
    command: >
      serve
      --mode all
      --api-keys app-key:acme
      --worker-token change-me-worker-token
      --retention-hours 168
    environment:
      DATABASE_URL: postgres://queueflow:queueflow@postgres:5432/queueflow
      RUST_LOG: info
    ports:
      - "8000:8000"
      - "9090:9090"
    depends_on:
      postgres:
        condition: service_healthy
```

## From source

```bash
git clone https://github.com/elision-labs/queueflow-core
cd queueflow-core
cargo build --release -p queueflow
./target/release/queueflow --version
```

`make test`, `make clippy`, and `make fmt-check` run the full suite without a database; `make test-pg` runs the opt-in Postgres integration tests against `TEST_DATABASE_URL`.

## Running the server

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
queueflow serve --mode all --workers 10 --api-port 8000
```

On startup the server:

1. Connects to Postgres with a pool of up to 50 connections (`--max-db-connections`).
2. Applies its embedded, idempotent sqlx migrations, creating the `queueflow` schema and its tables on first run (set the environment variable `QUEUEFLOW_AUTO_MIGRATE=false` to skip this and run `queueflow migrate` yourself, for example in a deploy step).
3. Serves the REST API on `--api-port` (default 8000), with Swagger UI at `/docs` and the spec at `/openapi.json`.
4. Serves Prometheus metrics on `--metrics-port` (default 9090) at `/metrics`.
5. In `all` or `worker` mode, starts `--workers` concurrent in-process workers on the default queue, the janitor, and the cron scheduler.
6. Warns loudly if any of the authentication flags are unset. See [Authentication and tenants](/concepts/auth).

It drains in-flight work on `SIGINT` or `SIGTERM`. See [Configuration](/configuration) for every flag.

## Applying migrations separately

```bash
queueflow migrate --database-url "$DATABASE_URL"
```

Migrations are plain SQL and idempotent (`CREATE TABLE IF NOT EXISTS`), so running them more than once is harmless. The schema is documented in [How it works](/internals).

## Verifying

```bash
curl -s http://localhost:8000/health   # 200 {"status":"ok",…}; 503 when the database is unreachable
curl -s http://localhost:8000/ready    # 200 once the server can take traffic
curl -s http://localhost:9090/metrics | grep queueflow_
```
