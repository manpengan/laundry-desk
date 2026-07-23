# V2 real PostgreSQL + server compose

This directory is the active v2 local integration environment. It runs the real
`@laundry/server` PG runtime, not the retired M0 mock Cloud server.

| Service    | Purpose                                                    | Host port |
| ---------- | ---------------------------------------------------------- | --------- |
| `postgres` | PostgreSQL 16; only role bootstrap is mounted at init      | `8543`    |
| `migrate`  | One-shot formal `0001`–current migration runner            | —         |
| `seed`     | One-shot, idempotent fictional `hongfa/main` identity seed | —         |
| `server`   | Real Fastify server using `laundry_app` + RLS              | `8787`    |

The old mock-server material is historical spike evidence only and is not part
of this compose topology. A future printer mock, if needed, must be labelled as
a mock and cannot be cited as Edge or hardware evidence.

## Start and verify

```bash
docker compose -f tools/compose/docker-compose.yml up -d --build

# Both commands are intentionally repeatable.
bash tools/compose/migrate-v2.sh
bash tools/compose/migrate-v2.sh
bash tools/compose/seed-v2.sh
bash tools/compose/seed-v2.sh

bash tools/compose/smoke-rls.sh
bash tools/compose/smoke-test.sh
```

`migrate-v2.sh` records each successfully applied SQL file in
`laundry_schema_migrations` with a SHA-256 checksum. A rerun is a no-op; a
changed historical migration fails closed. Migrations execute as
`postgres → SET ROLE laundry_owner`, because `laundry_owner` is intentionally
`NOLOGIN` after role hardening.

The local-only weak credentials are fixed for developer convenience:

- `postgres` / `postgres_secure_password`
- `laundry_app` / `app_secure_password` (`NOBYPASSRLS`)

Application code connects as `laundry_app`. RLS assertions therefore never use
the superuser connection that bootstraps the fictional demo tenant.

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

The server is already seeded with fictional credentials `hongfa` / `main` /
`admin` / `demo` and PIN `1234`.

## Reset

```bash
docker compose -f tools/compose/docker-compose.yml down -v
```

This removes only the `pgdata-v2` compose volume. It does not alter a host or
managed PostgreSQL database.
