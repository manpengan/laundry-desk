# packages/db migrations

Formal v2 PostgreSQL migrations for `@laundry/db`.

## Apply (owner connection)

```bash
export DATABASE_URL=postgresql://laundry_owner@localhost:5432/laundry_v2
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0001_roles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0002_m1_identity_platform.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0003_rls_and_grants.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0004_auth_lookup_functions.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0005_pin_lockouts.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0006_pin_challenge_stepup_binding.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0007_m2_orders.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0008_catalog_items.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0009_payments.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0010_print_jobs.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0011_customers.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0012_shift_closings.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0045_store_commissioning_staff_credentials.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0046_print_job_request_idempotency.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0047_cloud_counter_trust.sql
```

Tables are owned by the connecting role used at CREATE time. Prefer connecting as
`laundry_owner` (or a superuser that `SET ROLE laundry_owner`) so FORCE RLS is
meaningful for the application role `laundry_app`.

## Expand-only policy

Migrations must not contain `DROP TABLE`, `TRUNCATE`, `DROP COLUMN`, or
`DROP CONSTRAINT`. Static tests in `test/destructive-migration.test.ts` enforce this.

## Scope

- **M1**: identity/platform + A5 session tables
- **M2 skeleton** (0007): `orders`, `order_lines`, `garments`, `ticket_counters`
- **M2 catalog** (0008): `catalog_items` (store-scoped price list; app seeds demo on first list if empty)
- **M2 payments** (0009): `payments` append-only ledger (`SELECT, INSERT` only for `laundry_app`)
- **M2 print** (0010): `print_jobs` queue (`SELECT, INSERT, UPDATE` for status transitions; no DELETE)
- **M2 customers** (0011): `customers` org-scoped archive (`SELECT, INSERT, UPDATE`; unique org+phone)
- **M2 shift** (0012): `shift_closings` store-scoped 日结签字 (`SELECT, INSERT` only; one close per day)
- **Staff credential lifecycle** (0045, ADR-31): owner-only commissioning markers and store-scoped, non-secret, single-use credential setup references
- **Signed print request idempotency** (0046): database-derived logical keys make enqueue/retry/reprint exact across lost responses and concurrency
- **Cloud counter trust** (0047, ADR-38): store-scoped pricing policy, authoritative pricing snapshots, and per-piece draft/formal garment details
- Still deferred: edge lease, AI matrix tables
  (see `DEFERRED_V2_TABLES_NOTE` in `@laundry/db`)
