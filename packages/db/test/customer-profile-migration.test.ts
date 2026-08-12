import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

describe("0051 customer profile migration", () => {
  it("adds bounded profiles, canonical privacy groups, and HMAC tombstones", () => {
    const sql = readFileSync(join(migrationsDir, "0051_customer_extended_profiles.sql"), "utf8");

    for (const table of [
      "customer_profiles",
      "customer_addresses",
      "customer_identifiers",
      "customer_privacy_hmac_keys",
      "customer_erasure_tombstones",
      "customer_phone_history",
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "iu"));
    }
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.customer_canonical_root/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.customer_canonical_group/iu);
    expect(sql).toMatch(/customer merge cycle detected/iu);
    expect(sql).toMatch(/customer merge group size exceeded/iu);
    expect(sql).toMatch(
      /customer_merge_canonical[\s\S]*pg_advisory_xact_lock\(hashtextextended\(requested_org::text, 42\)\)/iu,
    );
    expect(sql).toMatch(
      /customer_privacy_export[\s\S]*pg_advisory_xact_lock\(hashtextextended\(authority\.org_id::text, 42\)\)/iu,
    );
    expect(sql).toMatch(
      /customer_privacy_anonymize[\s\S]*hashtextextended\('customer-phone:' \|\| authority\.org_id::text, 0\)/iu,
    );
    expect(sql).toMatch(
      /customer_phone_erased_for_org[\s\S]*hashtextextended\('customer-phone:' \|\| requested_org_id::text, 0\)/iu,
    );
    expect(sql).toMatch(/customers_reject_erased_phone_trg/iu);
    expect(sql).toMatch(
      /reject_erased_customer_phone[\s\S]*requested_org <> NEW\.org_id[\s\S]*customer_phone_erased\(NEW\.phone\)/iu,
    );
    expect(sql).toMatch(/MESSAGE = 'CUSTOMER_ERASED'/iu);
    expect(sql).toMatch(/customer_identifiers_active_value_uidx/iu);
    expect(sql).toMatch(/WHERE retired_at IS NULL AND normalized_value IS NOT NULL/iu);
    expect(sql).toMatch(/privacy_subject_customer_id uuid/iu);
    expect(sql).toMatch(/pii_purged_at timestamptz/iu);
    expect(sql).toMatch(/discount_bps integer NOT NULL DEFAULT 0/iu);
    expect(sql).toMatch(/customer_profile_version integer NOT NULL DEFAULT 0/iu);
    expect(sql).toMatch(/DELETE FROM ai_pending_actions/iu);
    expect(sql).toMatch(/pending\.args_json ->> 'customer_phone' = ANY\(group_phones\)/iu);
    expect(sql).toMatch(
      /customer_phone_history history[\s\S]*history\.customer_id = ANY\(group_ids\)[\s\S]*customer_phone_hmac\([\s\S]*pending\.args_json ->> 'customer_phone'/iu,
    );
    expect(sql).toMatch(/pending\.args_json ->> 'order_id' = ANY\(group_order_text_ids\)/iu);
    expect(sql).toMatch(/pending\.args_json ->> 'account_id' = ANY\(group_account_text_ids\)/iu);
    expect(sql).toMatch(/jsonb_array_elements_text[\s\S]*group_garment_text_ids/iu);
    expect(sql).toMatch(/UPDATE command_idempotency/iu);
    expect(sql).toMatch(/UPDATE edge_replay_records/iu);
    expect(sql).toMatch(/UPDATE audit_log/iu);
    expect(sql).toMatch(/audit_row\.entity_id = ANY\(related_audit_entity_ids\)/iu);
    expect(sql).toMatch(/UPDATE payments[\s\S]*SET note = NULL/iu);
    expect(sql).toMatch(
      /UPDATE (?:public\.)?order_lines[\s\S]*customer_redact_garment_details\(line\.garment_details_json\)/iu,
    );
    expect(sql).toMatch(/UPDATE garments[\s\S]*defects = '\[\]'::jsonb/iu);
    expect(sql).toMatch(/UPDATE garment_status_log[\s\S]*SET reason = NULL/iu);
    expect(sql).toMatch(/UPDATE garment_incidents[\s\S]*privacy_redacted_text/iu);
    expect(sql).toMatch(
      /UPDATE (?:public\.)?member_accounts[\s\S]*status_reason[\s\S]*privacy_redacted/iu,
    );
    expect(sql).toMatch(/UPDATE (?:public\.)?member_ledger[\s\S]*SET note = NULL/iu);
    expect(sql).toMatch(
      /UPDATE (?:public\.)?member_memberships[\s\S]*reason = (?:privacy_redacted_text|'privacy_redacted')/iu,
    );
    expect(sql).toMatch(/UPDATE (?:public\.)?points_ledger[\s\S]*kind = 'redeem'/iu);
    expect(sql).toMatch(
      /UPDATE (?:public\.)?punch_cards[\s\S]*reason = (?:privacy_redacted_text|'privacy_redacted')/iu,
    );
    expect(sql).toMatch(
      /UPDATE (?:public\.)?punch_card_ledger[\s\S]*reason = (?:privacy_redacted_text|'privacy_redacted')/iu,
    );
    expect(sql).toMatch(
      /UPDATE (?:public\.)?coupon_grants[\s\S]*reason = (?:privacy_redacted_text|'privacy_redacted')/iu,
    );
    expect(sql).toMatch(/UPDATE (?:public\.)?coupon_redemption_reversals[\s\S]*privacy_redacted/iu);
    expect(sql).toMatch(/customer_pii_purged_at timestamptz/iu);
    expect(sql).toMatch(/customer-privacy-pending:/iu);
    expect(sql).toMatch(
      /customer_guard_pending_write[\s\S]*customer_phone_erased_for_org\(NEW\.org_id, candidate\)[\s\S]*NEW\.privacy_subject_customer_id/iu,
    );
    expect(sql).toMatch(/customer_privacy_anchor_at[\s\S]*FOR SHARE/iu);
    expect(sql).toMatch(/args_json #>> '\{asset,asset_id\}'/iu);
    expect(sql).toMatch(/args_json -> 'order_ids'/iu);
    expect(sql).toMatch(/notification\.manual_list\.create/iu);
    expect(sql).toMatch(/audit_row\.entity = 'garment_batch'/iu);
    expect(sql).toMatch(/customer_guard_garment_photos_trg/iu);
    expect(sql).toMatch(/customer_guard_print_jobs_trg/iu);
    expect(sql).toMatch(/prune_expired_pending_actions_global/iu);
    expect(sql).toMatch(/requested_batch < 1 OR requested_batch > 100/iu);
    expect(sql).toMatch(/requested_batch IS NULL OR requested_batch < 1/iu);
    expect(sql).toMatch(/clock_timestamp\(\)/iu);
    expect(sql).toMatch(/ORDER BY pending\.status[\s\S]*LIMIT requested_batch/iu);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.prune_expired_pending_actions_global/iu);
    expect(sql).toMatch(/legacy customer print snapshot blocks privacy migration/iu);
    expect(sql).toMatch(/'format_version', 2/iu);
    expect(sql).toMatch(/'profiles', profile_rows/iu);
    expect(sql).toMatch(/profile\.customer_id = ANY\(group_ids\)/iu);
    expect(sql).toMatch(/combined_group_count > 1000 THEN RETURN/iu);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.customer_privacy_hmac_keys/iu);
    expect(sql).toMatch(
      /UPDATE customer_addresses[\s\S]*label = NULL[\s\S]*address_body = NULL[\s\S]*customer_id = ANY\(group_ids\)/iu,
    );
    expect(sql).toMatch(/customer_addresses_retired_label_purged_chk/iu);
    expect(sql).toMatch(/customer_privacy_events_reason_code_chk/iu);
    expect(sql).toMatch(/SET reason = 'legacy_request'/iu);
    expect(sql).toMatch(
      /UPDATE customer_identifiers[\s\S]*normalized_value = NULL[\s\S]*customer_id = ANY\(group_ids\)/iu,
    );
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|DROP\s+CONSTRAINT|(?:^|\n)\s*TRUNCATE\b/iu);
  });
});
