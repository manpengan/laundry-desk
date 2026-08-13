# packages/db migrations

Formal v2 PostgreSQL migrations for `@laundry/db`.

## Apply (owner connection)

```bash
export DATABASE_URL=postgresql://laundry_owner@localhost:5432/laundry_v2
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0001_roles.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0002_m1_identity_platform.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0003_rls_and_grants.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0004_auth_lookup_functions.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0005_pin_lockouts.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0006_pin_challenge_stepup_binding.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0007_m2_orders.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0008_catalog_items.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0009_payments.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0010_print_jobs.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0011_customers.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0012_shift_closings.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0045_store_commissioning_staff_credentials.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0046_print_job_request_idempotency.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0047_cloud_counter_trust.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0048_catalog_governance.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0049_cloud_owner_operations.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0050_member_benefits.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0051_customer_extended_profiles.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0052_notification_delivery_outbox.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0053_factory_handoff_and_qc.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0054_delivery_policy.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0055_delivery_appointments.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0056_delivery_orders.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0057_delivery_tasks.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0058_delivery_evidence.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0059_marketing_campaigns.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0060_campaign_coupon_batches.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0061_customer_self_service.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0062_customer_wallet_and_preferences.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0063_referral_and_group_buy.sql
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
- **Catalog governance** (0048): optimistic row versions, automatic version bump trigger, and app-role physical-delete revocation
- **Cloud Owner operations** (0049): optimistic current-store profile versions for audited public Owner management
- **M2 payments** (0009): `payments` append-only ledger (`SELECT, INSERT` only for `laundry_app`)
- **M2 print** (0010): `print_jobs` queue (`SELECT, INSERT, UPDATE` for status transitions; no DELETE)
- **M2 customers** (0011): `customers` org-scoped archive (`SELECT, INSERT, UPDATE`; unique org+phone)
- **M2 shift** (0012): `shift_closings` store-scoped 日结签字 (`SELECT, INSERT` only; one close per day)
- **Staff credential lifecycle** (0045, ADR-31): owner-only commissioning markers and store-scoped, non-secret, single-use credential setup references
- **Signed print request idempotency** (0046): database-derived logical keys make enqueue/retry/reprint exact across lost responses and concurrency
- **Cloud counter trust** (0047, ADR-38): store-scoped pricing policy, authoritative pricing snapshots, and per-piece draft/formal garment details
- **Catalog governance** (0048, ADR-39): optimistic versions for safe catalog update, activation, and atomic reorder; catalog retirement is soft-only for `laundry_app`
- **Cloud Owner operations** (0049, ADR-40): server-owned store profile versions; public Owner writes remain current-store-only
- **Member benefits** (0050, ADR-41): versioned tier/points/punch/coupon definitions and append-only, independently expiring virtual assets; stored-value money remains unchanged
- **Customer extended profiles** (0051, ADR-42): bounded customer profile children, canonical merge groups, HMAC erasure tombstones, durable PII purge ownership, and customer/tier discount plus operational-waiver order snapshots
- **Provider-neutral notification outbox** (0052, ADR-44): approved templates, bounded batches, leased deliveries, append-only attempts/receipts, cost evidence, and privacy-safe recipient/message fingerprints
- **Factory handoff and QC** (0053, ADR-45): store-scoped garment manifests, four immutable handoff checkpoints, discrepancy reconciliation, custody anchors, and append-only quality evidence
- **Delivery policy and policy-only quote** (0054, ADR-46): store-scoped bounded areas, integer-cent fees, weekly windows, booking rules, optimistic versions, forced RLS, and no reservation or feature enablement
- **Customer delivery appointments** (0055, ADR-47): opaque customer/address references, integer-cent fee snapshots, serialized slot capacity, database-enforced terminal reschedule/cancel lifecycle, immutable identity, and forced store RLS
- **Authoritative delivery orders** (0056, ADR-48): store-scoped laundry-order/appointment authority, integer-cent fee snapshots, database-enforced pickup/return lifecycle, optimistic CAS, irreversible terminal states, and forced store RLS
- **Authoritative delivery tasks** (0057, ADR-49): order-leg assignment custody, active-store staff authority, immutable transfer/takeover successor chains, optimistic CAS, order-owned completion/cancellation, and forced store RLS
- **Delivery evidence** (0058, ADR-51): append-only pickup/delivery evidence and attachment metadata with atomic task/order completion
- **Marketing campaigns** (0059, ADR-52): store-scoped campaign windows, strict audience rules, digest-only freezes, and integer-cent budget authority
- **Campaign coupon batches** (0060, ADR-53): bounded server-side eligibility, immutable grant provenance, exact budget debits, and auditable redemption reversals
- **Customer self-service orders** (0061, ADR-55): hashed customer sessions and canonical order/receipt/garment read projections
- **Customer wallet and preferences** (0062, ADR-56): existing wallet/benefit projections and bounded portal-owned address/preference CAS
- **Referral and group-buy** (0063, ADR-54): qualified referral grants, digest-only external vouchers, and single-use order redemption
- Still deferred: edge lease, AI matrix tables
  (see `DEFERRED_V2_TABLES_NOTE` in `@laundry/db`)
