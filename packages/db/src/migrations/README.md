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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0016_local_bootstrap.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0017_local_runtime_readiness.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0018_identity_lifecycle_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0019_money_integrity_workday.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0020_counter_lookup_codes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0021_print_job_lease.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0022_print_job_artifact.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0023_photo_file_integrity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0024_photo_delete_grant.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0025_fulfillment_operations.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0026_customer_profile_governance.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0027_garment_rack_operations.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0028_customer_privacy_lifecycle.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0029_staff_access_governance.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0030_edge_replay_authority.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0031_payment_ledger_sequence.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0032_member_stored_value.sql
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
- **Local bootstrap** (0016): `orgs.demo_only` plus owner-only singleton metadata for explicit local identity creation
- **Local runtime readiness** (0017): owner-defined boolean bootstrap proof plus removal of runtime organization and DDL writes
- **Identity lifecycle indexes** (0018): active device/session/family indexes for bounded auth transaction scans
- **Money integrity + workday** (0019): immutable price components, business-day ledger rows, and durable command replay
- **Counter lookup codes** (0020): customer-facing pickup codes plus store-scoped pickup/name-prefix indexes
- **Rack operations** (0027): authoritative rack position, immutable scan-to-rack history, and lookup index
- **Customer privacy lifecycle** (0028): audited bounded export and irreversible PII anonymization
- **Staff access governance** (0029): explicit privacy-admin authority, role invariants, and session revocation support
- **Edge replay authority** (0030): paired-device keys, signed grants, primary leases, and append-only replay arbitration
- **Payment ledger sequence** (0031): deterministic historical backfill plus database-assigned global ledger order
- **Member stored value** (0032, [ADR-17](../../../../docs/adr/2026-07-31-adr-17-member-stored-value.md)): org-scoped member accounts plus an append-only signed-delta ledger; the balance is `SUM(delta)` with no stored column, and `payments.method` gains `balance`
- Still deferred: AI matrix tables
  (see `DEFERRED_V2_TABLES_NOTE` in `@laundry/db`)
