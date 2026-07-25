# V2 real PostgreSQL + server compose

This directory is the active v2 local integration environment. It runs the real
`@laundry/server` PG runtime, not the retired M0 mock Cloud server.

| Service     | Purpose                                                   | Host port |
| ----------- | --------------------------------------------------------- | --------- |
| `postgres`  | PostgreSQL 16; only role bootstrap is mounted at init     | `8543`    |
| `migrate`   | One-shot formal `0001`–current migration runner           | —         |
| `bootstrap` | Explicit-profile, idempotent generic local identity setup | —         |
| `server`    | Real Fastify server using `laundry_app` + RLS             | `8787`    |

The old mock-server material is historical spike evidence only and is not part
of this compose topology. A future printer mock, if needed, must be labelled as
a mock and cannot be cited as Edge or hardware evidence.

## Start and verify

```bash
export LAUNDRY_ACCESS_TOKEN_SECRET="$(openssl rand -hex 32)"
export LAUNDRY_CSRF_PROOF_SECRET="$(openssl rand -hex 32)"
export LAUNDRY_BOOTSTRAP_ADMIN_USERNAME=admin
export LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME="Local Administrator"
export LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD="${LAUNDRY_TEST_ADMIN_PASSWORD:?set test password}"
export LAUNDRY_BOOTSTRAP_ADMIN_PIN="${LAUNDRY_TEST_ADMIN_PIN:?set test PIN}"
export LAUNDRY_LOCAL_ORG_CODE=local
export LAUNDRY_LOCAL_STORE_CODE=main

docker compose -f tools/compose/docker-compose.yml build server
docker compose -f tools/compose/docker-compose.yml up -d postgres
docker compose -f tools/compose/docker-compose.yml run --rm migrate
docker compose -f tools/compose/docker-compose.yml run --rm migrate
docker compose -f tools/compose/docker-compose.yml run --rm bootstrap
docker compose -f tools/compose/docker-compose.yml run --rm bootstrap
docker compose -f tools/compose/docker-compose.yml up -d server

bash tools/compose/smoke-rls.sh
bash tools/compose/smoke-test.sh
```

`migrate-v2.sh` records each successfully applied SQL file in
`laundry_schema_migrations` with a SHA-256 checksum. A rerun is a no-op; a
changed historical migration fails closed. Migrations execute as
`postgres → SET ROLE laundry_owner`, because `laundry_owner` is intentionally
`NOLOGIN` after role hardening.

The local-only database role credentials remain fixed until the guarded local
lifecycle work replaces them:

- `postgres` / `postgres_secure_password`
- `laundry_app` / `app_secure_password` (`NOBYPASSRLS`)

Application code connects as `laundry_app`. RLS assertions therefore never use
the superuser connection that bootstraps the generic local tenant. The
administrator password and PIN are required environment inputs and are never
stored in this repository.

## Real Web smoke

With compose still running, start the local Vite host in another terminal:

```bash
pnpm local:web
```

Then run the Playwright login/PIN walkthrough against the real PG server:

```bash
pnpm exec playwright install chromium
pnpm run local:web:e2e
```

The smoke reads the same `LAUNDRY_LOCAL_ORG_CODE`,
`LAUNDRY_LOCAL_STORE_CODE`, `LAUNDRY_BOOTSTRAP_ADMIN_USERNAME`, and
`LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD` values used by the explicit bootstrap.

## Reset

```bash
docker compose -f tools/compose/docker-compose.yml down -v
```

This removes only the `pgdata-v2` compose volume. It does not alter a host or
managed PostgreSQL database.
