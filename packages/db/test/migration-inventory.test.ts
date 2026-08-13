import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

const expectedSqlFiles = [
  "0001_roles.sql",
  "0002_m1_identity_platform.sql",
  "0003_rls_and_grants.sql",
  "0004_auth_lookup_functions.sql",
  "0005_pin_lockouts.sql",
  "0006_pin_challenge_stepup_binding.sql",
  "0007_m2_orders.sql",
  "0008_catalog_items.sql",
  "0009_payments.sql",
  "0010_print_jobs.sql",
  "0011_customers.sql",
  "0012_shift_closings.sql",
  "0013_garment_photos.sql",
  "0014_order_list_summary_indexes.sql",
  "0015_m2_counter_production_hardening.sql",
  "0016_local_bootstrap.sql",
  "0017_local_runtime_readiness.sql",
  "0018_identity_lifecycle_indexes.sql",
  "0019_money_integrity_workday.sql",
  "0020_counter_lookup_codes.sql",
  "0021_print_job_lease.sql",
  "0022_print_job_artifact.sql",
  "0023_photo_file_integrity.sql",
  "0024_photo_delete_grant.sql",
  "0025_fulfillment_operations.sql",
  "0026_customer_profile_governance.sql",
  "0027_garment_rack_operations.sql",
  "0028_customer_privacy_lifecycle.sql",
  "0029_staff_access_governance.sql",
  "0030_edge_replay_authority.sql",
  "0031_payment_ledger_sequence.sql",
  "0032_member_stored_value.sql",
  "0033_offline_grant_replay.sql",
  "0034_signed_print_dispatch.sql",
  "0035_member_tender_cash_reconciliation.sql",
  "0036_member_bonus_rules.sql",
  "0037_member_refund.sql",
  "0038_notification_manual_list.sql",
  "0039_accounting_report_indexes.sql",
  "0040_member_account_lifecycle.sql",
  "0041_owner_dashboard_indexes.sql",
  "0042_durable_pending_actions.sql",
  "0043_receipt_and_member_bonus_integrity.sql",
  "0044_durable_step_up_proofs.sql",
  "0045_store_commissioning_staff_credentials.sql",
  "0046_print_job_request_idempotency.sql",
  "0047_cloud_counter_trust.sql",
  "0048_catalog_governance.sql",
  "0049_cloud_owner_operations.sql",
  "0050_member_benefits.sql",
  "0051_customer_extended_profiles.sql",
  "0052_notification_delivery_outbox.sql",
  "0053_factory_handoff_and_qc.sql",
  "0054_delivery_policy.sql",
  "0055_delivery_appointments.sql",
  "0056_delivery_orders.sql",
  "0057_delivery_tasks.sql",
  "0058_delivery_evidence.sql",
  "0059_marketing_campaigns.sql",
  "0060_campaign_coupon_batches.sql",
  "0061_customer_self_service.sql",
  "0062_customer_wallet_and_preferences.sql",
  "0063_referral_and_group_buy.sql",
  "0064_byok_model_registry.sql",
  "0065_ai_streaming_sessions.sql",
  "0066_ai_safety_metering.sql",
  "0067_readonly_ai_assistant.sql",
  "0068_ai_approval_center.sql",
  "0069_bounded_automation.sql",
] as const;

describe("packages/db migration inventory", () => {
  const sqlFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  it("ships formal SQL migrations in gap-free lexical order", () => {
    expect(sqlFiles).toEqual(expectedSqlFiles);
  });

  it("uses unique zero-padded four-digit sequence numbers", () => {
    const prefixes = sqlFiles.map((name) => name.slice(0, 4));
    expect(prefixes.every((prefix) => /^\d{4}$/u.test(prefix))).toBe(true);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect([...prefixes].sort()).toEqual(prefixes);
  });
});
