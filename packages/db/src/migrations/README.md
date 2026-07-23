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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0013_garment_photos.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0014_order_list_summary_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0015_m2_counter_production_hardening.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0016_ai_credentials.sql
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
- **M2 garment photos** (0013): `garment_photos` append-only metadata (`SELECT, INSERT` only)
- **M2 order list** (0014): newest-first and customer-history indexes for the aggregate `order.list` read path
- **M2 production hardening** (0015): explicit append-only audit/payment grants and composite garment-photo ownership FK
- **M2 BYOK** (0016): envelope-encrypted credentials and append-only credential setup/verification audit
- Still deferred: edge lease, AI model matrix tables
  (see `DEFERRED_V2_TABLES_NOTE` in `@laundry/db`)
