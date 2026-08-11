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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0033_offline_grant_replay.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0034_signed_print_dispatch.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0035_member_tender_cash_reconciliation.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0036_member_bonus_rules.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0037_member_refund.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0038_notification_manual_list.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0039_accounting_report_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0040_member_account_lifecycle.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0041_owner_dashboard_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0042_durable_pending_actions.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0043_receipt_and_member_bonus_integrity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0044_durable_step_up_proofs.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0045_store_commissioning_staff_credentials.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0046_print_job_request_idempotency.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0047_cloud_counter_trust.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0048_catalog_governance.sql
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
- **Catalog governance** (0048, [ADR-39](../../../../docs/adr/2026-08-11-adr-39-catalog-governance.md)): optimistic row versions, automatic version bumps, atomic reorder, and app-role physical-delete revocation
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
- **Offline grant replay** (0033): independent grant sequence authority and durable replay acceptance
- **Signed print dispatch** (0034): authoritative print snapshots, one-time dispatch claims, and signed device receipts
- **Stored-value accounting and phase 2** (0035–0037): tender-aware cash reconciliation, bonus tiers, and principal-only refunds
- **Manual pickup reminders** (0038, [ADR-23](../../../../docs/adr/2026-08-07-adr-23-pickup-reminder-manual-list.md)): org-RLS append-only generation evidence with explicit store attribution and no raw phone/message/CSV retention
- **Accounting reports** (0039, [ADR-24](../../../../docs/adr/2026-08-07-adr-24-accounting-dual-basis-reports.md)): bounded tenant/store/date/staff indexes for immutable payment and stored-value ledger reads
- **Member lifecycle** (0040, ADR-25): versioned active/frozen/closed account state and append-only bonus forfeiture on atomic closure
- **Owner dashboard** (0041, ADR-26): bounded store pickup-transition index; financial reads continue to reuse ADR-24 accounting indexes
- **Durable confirmation authority** (0042, ADR-05): tenant-scoped canonical WYSIWYS cards with transaction-local single-consume state; invalid cards are pruned opportunistically in bounded batches after a 30-day retention window, while recent durable response replay remains protected
- **Receipt and member bonus integrity** (0043): defines `orders.created_at` as the formal receipt/open instant and rejects positive bonus ledger entries without a governing bonus rule
- **Durable step-up authority** (0044, ADR-05): tenant-scoped two-person approval proofs whose CAS consumption joins the business and audit transaction
- **Store commissioning and staff credentials** (0045, ADR-31): permanent dual-admin commissioning metadata plus tenant-scoped, expiring, single-use credential setup references with no retained secrets
- **Signed print request idempotency** (0046): database-derived logical keys make original enqueue and source-bound retry/reprint exact across lost responses and concurrent clients; unambiguous legacy rows are backfilled while duplicate history remains fail-closed
- **Cloud counter trust** (0047, [ADR-38](../../../../docs/adr/2026-08-11-adr-38-cloud-counter-trust-closure.md)): store-scoped pricing policy with RLS, authoritative order pricing selections/snapshots, and persistent per-piece draft/formal garment details
- Still deferred: AI matrix tables
  (see `DEFERRED_V2_TABLES_NOTE` in `@laundry/db`)
