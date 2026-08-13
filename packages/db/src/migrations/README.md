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
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0013_garment_photos.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0014_order_list_summary_indexes.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0015_m2_counter_production_hardening.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0016_local_bootstrap.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0017_local_runtime_readiness.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0018_identity_lifecycle_indexes.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0019_money_integrity_workday.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0020_counter_lookup_codes.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0021_print_job_lease.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0022_print_job_artifact.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0023_photo_file_integrity.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0024_photo_delete_grant.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0025_fulfillment_operations.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0026_customer_profile_governance.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0027_garment_rack_operations.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0028_customer_privacy_lifecycle.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0029_staff_access_governance.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0030_edge_replay_authority.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0031_payment_ledger_sequence.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0032_member_stored_value.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0033_offline_grant_replay.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0034_signed_print_dispatch.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0035_member_tender_cash_reconciliation.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0036_member_bonus_rules.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0037_member_refund.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0038_notification_manual_list.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0039_accounting_report_indexes.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0040_member_account_lifecycle.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0041_owner_dashboard_indexes.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0042_durable_pending_actions.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0043_receipt_and_member_bonus_integrity.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0044_durable_step_up_proofs.sql
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
# 0064 只能在集成分支已具备并应用 0054–0063 后执行；本 Item 不伪造占位迁移。
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0064_byok_model_registry.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0065_ai_streaming_sessions.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0066_ai_safety_metering.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0067_readonly_ai_assistant.sql
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0068_ai_approval_center.sql
# 0069 只能在最终集成分支已具备并应用 0065–0068 后执行；本 Item 不伪造占位迁移。
psql "$DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f src/migrations/0069_bounded_automation.sql
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
- **Cloud Owner operations** (0049, [ADR-40](../../../../docs/adr/2026-08-11-adr-40-cloud-owner-operations.md)): optimistic current-store profile versions for audited public Owner management
- **Member benefits** (0050, [ADR-41](../../../../docs/adr/2026-08-11-adr-41-member-benefits-and-expiry.md)): versioned tier/points/punch/coupon definitions, independent expiry snapshots, append-only usage/reversal evidence, and atomic coupon/order cancellation support
- **Customer extended profiles** (0051, [ADR-42](../../../../docs/adr/2026-08-12-adr-42-customer-extended-profiles-and-discount-policy.md)): bounded org-scoped profile/address/identifier rows, recursive canonical groups, owner-only HMAC erasure tombstones, privacy-copy purge metadata, tier/customer discount snapshots, and order waiver snapshots
- **Provider-neutral notification outbox** (0052, [ADR-44](../../../../docs/adr/2026-08-12-adr-44-provider-neutral-notification-outbox.md)): approved org templates, bounded store batches, leased delivery state, append-only attempt/receipt evidence, integer cost guards, and privacy-safe fingerprints
- **Factory handoff and QC** (0053, [ADR-45](../../../../docs/adr/2026-08-12-adr-45-factory-handoff-and-qc.md)): store-scoped garment manifests, four immutable handoff checkpoints, discrepancy reconciliation, custody anchors, and append-only quality evidence
- **Delivery policy and policy-only quote** (0054, [ADR-46](../../../../docs/adr/2026-08-13-adr-46-delivery-policy-and-policy-only-availability.md)): store-scoped bounded areas, integer-cent fees, weekly windows, booking rules, optimistic versions, forced RLS, and no reservation or feature enablement
- **Customer delivery appointments** (0055, [ADR-47](../../../../docs/adr/2026-08-13-adr-47-customer-delivery-appointments.md)): opaque customer/address references, integer-cent fee snapshots, serialized slot capacity, database-enforced terminal reschedule/cancel lifecycle, immutable identity, and forced store RLS
- **Authoritative delivery orders** (0056, [ADR-48](../../../../docs/adr/2026-08-13-adr-48-authoritative-delivery-orders.md)): store-scoped laundry-order/appointment authority, integer-cent fee snapshots, database-enforced pickup/return lifecycle, optimistic CAS, irreversible terminal states, and forced store RLS
- **Authoritative delivery tasks** (0057, [ADR-49](../../../../docs/adr/2026-08-13-adr-49-authoritative-delivery-tasks.md)): order-leg assignment custody, active-store staff authority, immutable transfer/takeover successor chains, optimistic CAS, order-owned completion/cancellation, and forced store RLS
- **Delivery evidence** (0058, [ADR-51](../../../../docs/adr/2026-08-13-adr-51-delivery-evidence.md)): append-only pickup/delivery evidence and attachment metadata with atomic task/order completion
- **Marketing campaigns** (0059, [ADR-52](../../../../docs/adr/2026-08-13-adr-52-store-marketing-campaigns.md)): store-scoped campaign windows, strict audience rules, digest-only freezes, and integer-cent budget authority
- **Campaign coupon batches** (0060, [ADR-53](../../../../docs/adr/2026-08-13-adr-53-campaign-coupon-issuance.md)): bounded server-side eligibility, immutable grant provenance, exact budget debits, and auditable redemption reversals
- **Customer self-service orders** (0061, [ADR-55](../../../../docs/adr/2026-08-13-adr-55-customer-self-service-orders.md)): short-lived customer authority and canonical order/receipt/garment projections
- **Customer wallet and preferences** (0062, [ADR-56](../../../../docs/adr/2026-08-13-adr-56-customer-wallet-and-preferences.md)): wallet/benefit projections plus canonical CAS over portal-owned addresses and notification preferences
- **Referral and group-buy** (0063, [ADR-54](../../../../docs/adr/2026-08-13-adr-54-referral-and-group-buy.md)): active-member referral rewards and digest-only external vouchers with single-use order redemption
- **BYOK custody and model registry** (0064, [ADR-57](../../../../docs/adr/2026-08-13-adr-57-byok-custody-model-registry.md)): org-RLS AES-256-GCM envelopes with KMS-wrapped per-credential DEKs, fail-closed lifecycle transitions, and an empty owner-verified global model registry; requires the integrated 0054–0063 chain first
- **Bounded AI streaming state** (0065, [ADR-58](../../../../docs/adr/2026-08-13-adr-58-bounded-ai-streaming-runtime.md)): tenant/session/staff-scoped sessions, append-only messages and events, bounded usage/tool-attempt metadata, closed write functions, FORCE RLS, and no direct application DML; public AI remains hard-off
- **AI safety metering** (0066, [ADR-59](../../../../docs/adr/2026-08-13-adr-59-ai-safety-metering.md)): integer token/cost ledgers, atomic org budget reservations, durable circuit state, metadata-only rejection evidence, FORCE RLS, and owner-only status; public AI remains hard-off
- **Read-only AI assistant** (0067, [ADR-62](../../../../docs/adr/2026-08-13-adr-62-readonly-ai-assistant.md)): three closed business/search/procedure tools over existing query authority, bounded metadata-only attempts, explicit source/filter projections, and no write/SQL/URL/header escape hatch
- **R4 asynchronous approval center** (0068, [ADR-61](../../../../docs/adr/2026-08-13-adr-61-r4-asynchronous-approval-center.md)): store-scoped single-level approval requests bound to the existing WYSIWYS pending action, current other-admin authority, optimistic decision versions and transaction-local single consumption; requires the integrated 0065–0067 chain first
- **Bounded automation** (0069, [ADR-63](../../../../docs/adr/2026-08-13-adr-63-bounded-automation.md)): store-RLS allowlisted policies, active-admin approval, daily integer-fen quotas, leases and privacy-safe action evidence; requires the integrated 0065–0068 chain first
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
- Still deferred: writable AI tools and remaining matrix tables
  (see `DEFERRED_V2_TABLES_NOTE` in `@laundry/db`)
