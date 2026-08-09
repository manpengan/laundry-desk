import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

describe("packages/db migration file inventory", () => {
  it("ships formal SQL migrations ordered 0001 → 0045", () => {
    const sqlFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    expect(sqlFiles).toEqual([
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
    ]);
  });

  it("prefixes are unique zero-padded four-digit sequence numbers", () => {
    const sqlFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const prefixes = sqlFiles.map((name) => name.slice(0, 4));
    expect(prefixes.every((prefix) => /^\d{4}$/u.test(prefix))).toBe(true);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
      "0015",
      "0016",
      "0017",
      "0018",
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
      "0037",
      "0038",
      "0039",
      "0040",
      "0041",
      "0042",
      "0043",
      "0044",
      "0045",
    ]);
    expect([...prefixes].sort()).toEqual(prefixes);
  });

  it("adds append-only manual notification evidence without retaining raw PII", () => {
    const sql = readFileSync(join(migrationsDir, "0038_notification_manual_list.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS notification_log/iu);
    expect(sql).toMatch(/channel text NOT NULL/iu);
    expect(sql).toMatch(/status text NOT NULL/iu);
    expect(sql).toMatch(/CHECK \(channel = 'manual'\)/iu);
    expect(sql).toMatch(/CHECK \(status = 'list_generated'\)/iu);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE notification_log TO laundry_app/iu);
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE notification_log FROM laundry_app/iu,
    );
    expect(sql).not.toMatch(/customer_phone|message_body|csv text/iu);
  });

  it("indexes bounded tenant/store accounting report scans", () => {
    const sql = readFileSync(join(migrationsDir, "0039_accounting_report_indexes.sql"), "utf8");
    expect(sql).toMatch(
      /ON public\.payments \(org_id, store_id, business_date, staff_id, method, kind\)/iu,
    );
    expect(sql).toMatch(
      /ON public\.member_ledger \(org_id, store_id, business_date, staff_id, tender\)/iu,
    );
    expect(sql).toMatch(/WHERE tender IS NOT NULL/iu);
  });

  it("adds versioned member lifecycle and constrained append-only bonus forfeiture", () => {
    const sql = readFileSync(join(migrationsDir, "0040_member_account_lifecycle.sql"), "utf8");
    expect(sql).toMatch(/status_version integer NOT NULL DEFAULT 1/iu);
    expect(sql).toMatch(/ALTER COLUMN principal_delta_cents TYPE bigint/iu);
    expect(sql).toMatch(/ALTER COLUMN bonus_delta_cents TYPE bigint/iu);
    expect(sql).toMatch(/status IN \('active', 'frozen', 'closed'\)/iu);
    expect(sql).toMatch(/kind IN \('topup', 'pay', 'reversal', 'refund', 'bonus_forfeit'\)/iu);
    expect(sql).toMatch(/member_ledger_bonus_forfeit_shape_chk/iu);
    expect(sql).toMatch(/principal_delta_cents = 0/iu);
    expect(sql).toMatch(/bonus_delta_cents < 0/iu);
    expect(sql).toMatch(/tender IS NULL/iu);
    expect(sql).toMatch(/bonus_rule_id IS NULL/iu);
  });

  it("indexes bounded store pickup-transition scans for the owner dashboard", () => {
    const sql = readFileSync(join(migrationsDir, "0041_owner_dashboard_indexes.sql"), "utf8");
    expect(sql).toMatch(/ON public\.garment_status_log \(org_id, store_id, to_status, at\)/iu);
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP\s/u);
  });

  it("persists tenant-scoped confirmation cards for transaction-local CAS consumption", () => {
    const sql = readFileSync(join(migrationsDir, "0042_durable_pending_actions.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ai_pending_actions/iu);
    expect(sql).toMatch(/args_json jsonb NOT NULL/iu);
    expect(sql).toMatch(/authority_json jsonb/iu);
    expect(sql).toMatch(/args_hash char\(64\) NOT NULL/iu);
    expect(sql).toMatch(/idempotency_key uuid NOT NULL/iu);
    expect(sql).toMatch(/status IN \('pending', 'consumed', 'expired', 'denied'\)/iu);
    expect(sql).toMatch(
      /ai_pending_actions_creator_staff_idx[\s\S]*\(org_id, creator_staff_id\)/iu,
    );
    expect(sql).toMatch(
      /ai_pending_actions_consumer_staff_idx[\s\S]*\(org_id, consumed_by_staff_id\)[\s\S]*WHERE consumed_by_staff_id IS NOT NULL/iu,
    );
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_pending_actions TO laundry_app/iu,
    );
    expect(sql).not.toMatch(/command_idempotency[\s\S]*args_json/iu);
  });

  it("defines the receipt clock and rejects ruleless positive member bonuses", () => {
    const sql = readFileSync(
      join(migrationsDir, "0043_receipt_and_member_bonus_integrity.sql"),
      "utf8",
    );
    expect(sql).toMatch(/COMMENT ON COLUMN orders\.created_at/iu);
    expect(sql).toMatch(/formal receipt\/open instant/iu);
    expect(sql).toMatch(/WHERE command = 'order\.receive'/iu);
    expect(sql).toMatch(/AND entity = 'order'/iu);
    expect(sql).toMatch(/MIN\(at\) AS received_at/iu);
    expect(sql).toMatch(/COALESCE\(receipt_audit\.received_at, orders\.updated_at\)/iu);
    expect(sql).toMatch(/SET created_at = receipt_clock\.received_at/iu);
    expect(sql).toMatch(/member_ledger_positive_bonus_origin_chk/iu);
    expect(sql).toMatch(/kind <> 'topup' OR bonus_delta_cents <= 0 OR bonus_rule_id IS NOT NULL/iu);
  });

  it("persists tenant-scoped step-up proofs with transaction-local CAS consumption", () => {
    const sql = readFileSync(join(migrationsDir, "0044_durable_step_up_proofs.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS step_up_proofs/iu);
    expect(sql).toMatch(/pending_action_ref uuid NOT NULL/iu);
    expect(sql).toMatch(
      /FOREIGN KEY \(org_id, store_id, pending_action_ref\)[\s\S]*REFERENCES ai_pending_actions \(org_id, store_id, nonce\) ON DELETE CASCADE/iu,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(org_id, store_id, session_id\) REFERENCES sessions \(org_id, store_id, id\)/iu,
    );
    expect(sql).toMatch(/entity_versions_json jsonb NOT NULL/iu);
    expect(sql).toMatch(/status IN \('active', 'consumed'\)/iu);
    expect(sql).toMatch(/requester_staff_id <> approver_staff_id/iu);
    expect(sql).toMatch(
      /step_up_proofs_pending_fk_idx[\s\S]*\(org_id, store_id, pending_action_ref\)/iu,
    );
    expect(sql).toMatch(
      /step_up_proofs_requester_staff_idx[\s\S]*\(org_id, requester_staff_id\)/iu,
    );
    expect(sql).toMatch(/step_up_proofs_approver_staff_idx[\s\S]*\(org_id, approver_staff_id\)/iu);
    expect(sql).toMatch(/step_up_proofs_session_idx[\s\S]*\(org_id, store_id, session_id\)/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE step_up_proofs TO laundry_app/iu);
  });

  it("persists permanent commissioning state and non-secret credential setup authority", () => {
    const sql = readFileSync(
      join(migrationsDir, "0045_store_commissioning_staff_credentials.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS approver_staff_id uuid/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS commissioned_at timestamptz/iu);
    expect(sql).toMatch(/feature_profile_version integer NOT NULL DEFAULT 0/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.laundry_local_bootstrap_ready/iu);
    const baseReadiness = sql.match(
      /CREATE OR REPLACE FUNCTION public\.laundry_local_bootstrap_ready[\s\S]*?\$\$;/iu,
    )?.[0];
    const commissioningState = sql.match(
      /CREATE OR REPLACE FUNCTION public\.laundry_local_commissioning_state[\s\S]*?\$\$;/iu,
    )?.[0];
    expect(baseReadiness).toBeDefined();
    expect(baseReadiness).not.toMatch(/metadata\.approver_staff_id IS NOT NULL/iu);
    expect(baseReadiness).not.toMatch(/metadata\.commissioned_at IS NOT NULL/iu);
    expect(baseReadiness).not.toMatch(/metadata\.feature_profile_version = 1/iu);
    expect(commissioningState).toMatch(
      /metadata\.approver_staff_id = expected_approver_staff_id/iu,
    );
    expect(commissioningState).toMatch(/metadata\.commissioned_at IS NOT NULL/iu);
    expect(commissioningState).toMatch(
      /metadata\.feature_profile_version = expected_feature_profile_version/iu,
    );
    expect(commissioningState).toMatch(/THEN 'commission_required'/iu);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS staff_credential_setups/iu);
    expect(sql).toMatch(/purpose IN \('create', 'reset'\)/iu);
    expect(sql).toMatch(/status IN \('pending', 'consumed', 'expired'\)/iu);
    expect(sql).toMatch(/staff_credential_setups_target_pending_uidx/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE staff_credential_setups TO laundry_app/iu,
    );
    expect(sql).toMatch(
      /sessions_active_staff_idx[\s\S]*ON public\.sessions \(org_id, staff_id\)[\s\S]*WHERE status = 'active'/iu,
    );
    expect(sql).toMatch(/sessions_staff_idx[\s\S]*ON public\.sessions \(org_id, staff_id\)/iu);
    expect(sql).toMatch(
      /refresh_families_active_org_session_idx[\s\S]*\(org_id, session_id\)[\s\S]*WHERE status = 'active'/iu,
    );
    expect(sql).toMatch(
      /refresh_tokens_active_org_session_idx[\s\S]*\(org_id, session_id\)[\s\S]*WHERE status = 'active'/iu,
    );
    const sessionRevocation = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.laundry_revoke_staff_sessions"),
    );
    expect(sessionRevocation).toMatch(/SECURITY DEFINER/iu);
    expect(sessionRevocation).toMatch(/STRICT/iu);
    expect(sessionRevocation).toMatch(/SET search_path = pg_catalog, pg_temp/iu);
    expect(sessionRevocation).toMatch(/current_setting\('app\.org_id'/iu);
    expect(sessionRevocation).toMatch(/actor_role\.role = 'admin'/iu);
    expect(sessionRevocation).toMatch(
      /session\.org_id = expected_org_id[\s\S]*session\.staff_id = expected_target_staff_id/iu,
    );
    expect(sessionRevocation).not.toMatch(/store_id IN|session\.store_id = expected_store_id/iu);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.laundry_revoke_staff_sessions[\s\S]*FROM PUBLIC/iu,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.laundry_revoke_staff_sessions[\s\S]*TO laundry_app, laundry_owner/iu,
    );
    expect(sql).not.toMatch(/password|pin_hash|password_hash|credential_hash/iu);
  });

  it("adds order.list indexes after the garment photos migration", () => {
    const sql = readFileSync(join(migrationsDir, "0014_order_list_summary_indexes.sql"), "utf8");
    expect(sql).toMatch(/ON orders \(org_id, store_id, created_at DESC, ticket_no DESC\)/iu);
    expect(sql).toMatch(
      /ON orders \(org_id, store_id, customer_phone, created_at DESC, ticket_no DESC\)/iu,
    );
  });

  it("hardens append-only grants and photo ownership after the list indexes", () => {
    const sql = readFileSync(
      join(migrationsDir, "0015_m2_counter_production_hardening.sql"),
      "utf8",
    );
    expect(sql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM laundry_app/iu);
    expect(sql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE payments FROM laundry_app/iu);
    expect(sql).toMatch(/garment_photos_garment_order_fk/iu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, store_id, order_id, garment_id\)/iu);
  });

  it("adds owner-only local bootstrap metadata after production hardening", () => {
    const sql = readFileSync(join(migrationsDir, "0016_local_bootstrap.sql"), "utf8");

    expect(sql).toMatch(
      /ALTER TABLE orgs\s+ADD COLUMN IF NOT EXISTS demo_only boolean NOT NULL DEFAULT false/iu,
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS local_bootstrap_metadata/iu);
    expect(sql).toMatch(/singleton boolean PRIMARY KEY DEFAULT true/iu);
    expect(sql).toMatch(/CHECK \(singleton\)/iu);
    expect(sql).toMatch(/profile_hash char\(64\) NOT NULL/iu);
    expect(sql).toMatch(/profile_hash ~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, store_id\) REFERENCES stores \(org_id, id\)/iu);
    expect(sql).toMatch(
      /FOREIGN KEY \(org_id, admin_staff_id\) REFERENCES staffs \(org_id, id\)/iu,
    );
    expect(sql).toMatch(/REVOKE ALL ON TABLE local_bootstrap_metadata FROM PUBLIC, laundry_app/iu);
  });

  it("exposes only a boolean bootstrap proof and revokes runtime organization writes", () => {
    const sql = readFileSync(join(migrationsDir, "0017_local_runtime_readiness.sql"), "utf8");

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.laundry_local_bootstrap_ready/iu);
    expect(sql).toMatch(/RETURNS boolean/iu);
    expect(sql).toMatch(/SECURITY DEFINER/iu);
    expect(sql).toMatch(/SET search_path = pg_catalog/iu);
    expect(sql).toMatch(/public\.local_bootstrap_metadata/iu);
    expect(sql).toMatch(/public\.orgs/iu);
    expect(sql).toMatch(/public\.stores/iu);
    expect(sql).toMatch(/public\.staffs/iu);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.laundry_local_bootstrap_ready[\s\S]*FROM PUBLIC/iu,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.laundry_local_bootstrap_ready[\s\S]*TO laundry_app, laundry_owner/iu,
    );
    expect(sql).toMatch(/REVOKE INSERT, UPDATE ON TABLE public\.orgs FROM laundry_app/iu);
    expect(sql).toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC, laundry_app/iu);
    expect(sql).toMatch(/REVOKE CREATE ON DATABASE %I FROM PUBLIC, laundry_app/iu);
    expect(sql).toMatch(/REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, laundry_app/iu);

    const hardenedDefinerFunctions = new Map([
      ["laundry_auth_find_org_store", ["public.orgs", "public.stores"]],
      ["laundry_auth_lookup_session", ["public.sessions", "public.refresh_families"]],
      ["laundry_auth_lookup_family", ["public.refresh_families"]],
      ["laundry_auth_lookup_refresh_by_hash", ["public.refresh_tokens"]],
      ["laundry_auth_lookup_refresh_by_id", ["public.refresh_tokens"]],
      ["laundry_auth_lookup_pin", ["public.pin_challenges", "public.sessions"]],
    ]);
    for (const [functionName, qualifiedRelations] of hardenedDefinerFunctions) {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
      expect(start, `${functionName} must be redefined by 0017`).toBeGreaterThanOrEqual(0);
      const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 1);
      const definition = sql.slice(start, next === -1 ? undefined : next);

      expect(definition).toMatch(/SECURITY DEFINER/iu);
      expect(definition).toMatch(/SET search_path = pg_catalog, pg_temp/iu);
      for (const relation of qualifiedRelations) {
        expect(definition).toContain(relation);
      }
    }
  });

  it("indexes the exact active identity lifecycle predicates", () => {
    const sql = readFileSync(join(migrationsDir, "0018_identity_lifecycle_indexes.sql"), "utf8");
    expect(sql).toMatch(/ON sessions \(org_id, store_id, device_id\)\s+WHERE status = 'active'/iu);
    expect(sql).toMatch(
      /ON refresh_families \(org_id, store_id, session_id\)\s+WHERE status = 'active'/iu,
    );
    expect(sql).toMatch(
      /ON refresh_tokens \(org_id, store_id, family_id\)\s+WHERE status = 'active'/iu,
    );
  });

  it("adds money snapshots, business dates, and durable command replay state", () => {
    const sql = readFileSync(join(migrationsDir, "0019_money_integrity_workday.sql"), "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS original_cents integer NOT NULL DEFAULT 0/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS business_date text/iu);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS command_idempotency/iu);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE command_idempotency TO laundry_app/iu,
    );
  });

  // `standard_conforming_strings` is on, so a `\\d` inside a SQL string literal is
  // a literal backslash followed by `d` — a CHECK written that way rejects every
  // value it is meant to accept. 0019 shipped exactly that bug on
  // orders.business_date and payments.business_date.
  it("writes regex CHECK literals with single-escaped classes", () => {
    const offenders = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .flatMap((name) => {
        const sql = readFileSync(join(migrationsDir, name), "utf8");
        return sql.includes("\\\\d") || sql.includes("\\\\w") || sql.includes("\\\\s")
          ? [name]
          : [];
      });

    expect(offenders).toEqual([]);
  });

  // Scans every migration rather than a fixed file list: 0019 shipped a
  // business_date regex that rejected all real dates, and a list that has to be
  // extended by hand is exactly how the next one would slip through too.
  it("constrains business_date to a regex that accepts a real ISO date", () => {
    const names = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    let checked = 0;

    for (const name of names) {
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      for (const [, pattern] of sql.matchAll(/business_date\s*~\s*'([^']+)'/gu)) {
        expect(new RegExp(pattern ?? "").test("2026-07-28"), `${name}: ${pattern}`).toBe(true);
        checked += 1;
      }
    }

    // Guard the guard: a refactor that renames the column or changes the CHECK
    // shape must not silently reduce this to a no-op pass.
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("keeps the Edge SPKI length outside PostgreSQL's bounded-repeat limit", () => {
    const sql = readFileSync(join(migrationsDir, "0030_edge_replay_authority.sql"), "utf8");

    expect(sql).toMatch(/char_length\(public_key_spki\) BETWEEN 40 AND 256/iu);
    expect(sql).toMatch(/public_key_spki ~ '\^\[A-Za-z0-9_-\]\+\$'/iu);
    expect(sql).not.toContain("{40,256}");
  });

  it("adds print worker lease state without allowing a partial claim", () => {
    const sql = readFileSync(join(migrationsDir, "0021_print_job_lease.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS lease_until timestamptz/iu);
    expect(sql).toMatch(/print_jobs_lease_shape_chk/iu);
    expect(sql).toMatch(/print_jobs_store_claimable_idx/iu);
  });

  it("records print artifact metadata as one verifiable unit", () => {
    const sql = readFileSync(join(migrationsDir, "0022_print_job_artifact.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS artifact_sha256 text/iu);
    expect(sql).toMatch(/print_jobs_artifact_shape_chk/iu);
    expect(sql).toMatch(/print_jobs_artifact_path_chk/iu);
    expect(sql).toMatch(/print_jobs_artifact_path_uidx/iu);
  });

  it("binds photo metadata to server-owned files with a content digest", () => {
    const sql = readFileSync(join(migrationsDir, "0023_photo_file_integrity.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS content_sha256 text/iu);
    expect(sql).toMatch(/garment_photos_content_sha256_chk/iu);
    expect(sql).toMatch(/garment_photos_storage_key_uidx/iu);
  });

  it("grants only the additional photo mutation required by audited deletion", () => {
    const sql = readFileSync(join(migrationsDir, "0024_photo_delete_grant.sql"), "utf8");
    expect(sql).toMatch(/GRANT DELETE ON TABLE garment_photos TO laundry_app/iu);
    expect(sql).not.toMatch(/GRANT[^;]*(?:UPDATE|TRUNCATE)[^;]*garment_photos/iu);
  });

  it("adds customer pickup codes and bounded name-prefix lookup indexes", () => {
    const sql = readFileSync(join(migrationsDir, "0020_counter_lookup_codes.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pickup_code text/iu);
    expect(sql).toMatch(/orders_pickup_code_uidx/iu);
    expect(sql).toMatch(/lower\(customer_name\) text_pattern_ops/iu);
  });

  it("binds privacy history to stable customer ids and requires admin authority", () => {
    const sql = readFileSync(join(migrationsDir, "0028_customer_privacy_lifecycle.sql"), "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS customer_id uuid/iu);
    expect(sql).toMatch(/CONSTRAINT orders_customer_fk/iu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, customer_id\)/iu);
    expect(sql).toMatch(/orders_org_customer_created_idx/iu);
    expect(sql).toMatch(/linked_order\.customer_id = requested_customer_id/iu);
    expect(sql).toMatch(/order_row\.customer_id = requested_customer_id/iu);
    expect(sql).toMatch(/customer_id = customer_row\.id/iu);
    expect(sql).toMatch(/authority\.staff_role <> 'admin'/iu);
    const privacyFunctions = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION customer_privacy_status"),
    );
    expect(privacyFunctions).not.toMatch(/customer_phone = customer_row\.phone/iu);
  });

  it("persists device authority and append-only ordered replay arbitration", () => {
    const sql = readFileSync(join(migrationsDir, "0030_edge_replay_authority.sql"), "utf8");

    for (const table of [
      "edge_authority_challenges",
      "edge_devices",
      "offline_grants",
      "primary_lease_heads",
      "primary_leases",
      "primary_lease_replay_state",
      "edge_replay_records",
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "iu"));
    }
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/edge_replay_records_accepted_queue_uidx/iu);
    expect(sql).toMatch(/edge_replay_records_accepted_seq_uidx/iu);
    expect(sql).toMatch(/CONSTRAINT primary_leases_grant_fk/iu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, store_id, grant_id\)/iu);
    expect(sql).toMatch(/request_nonce uuid NOT NULL/iu);
    expect(sql).toMatch(/edge_authority_challenges_device_uidx/iu);
    expect(sql).toMatch(/edge_authority_challenges_request_nonce_uidx/iu);
    expect(sql).toMatch(/offline_grants_request_nonce_uidx/iu);
    expect(sql).toMatch(/pairing_code_hash char\(64\)/iu);
    expect(sql).toMatch(/pairing_code_required boolean NOT NULL/iu);
    expect(sql).toMatch(/expected_primary_epoch bigint/iu);
    expect(sql).toMatch(/GRANT SELECT, INSERT, DELETE ON TABLE edge_authority_challenges/iu);
    expect(sql).toMatch(/GRANT UPDATE \(consumed_at\) ON TABLE edge_authority_challenges/iu);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE edge_replay_records TO laundry_app/iu);
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE edge_replay_records FROM laundry_app/iu,
    );
  });

  it("adds grant replay state and mutually exclusive replay authorization shapes", () => {
    const sql = readFileSync(join(migrationsDir, "0033_offline_grant_replay.sql"), "utf8");

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS offline_grant_replay_state/iu);
    expect(sql).toMatch(/REFERENCES offline_grants \(org_id, store_id, id\)/iu);
    expect(sql).toMatch(/authorization_kind text/iu);
    expect(sql).toMatch(/reported_per_grant_seq bigint/iu);
    expect(sql).toMatch(/accepted_per_grant_seq bigint/iu);
    expect(sql).toMatch(/authorization_kind = 'grant'[\s\S]*lease_id IS NULL/iu);
    expect(sql).toMatch(/authorization_kind = 'primary_lease'[\s\S]*lease_id IS NOT NULL/iu);
    expect(sql).toMatch(/reported_per_grant_seq IS NOT NULL[\s\S]*reported_per_grant_seq > 0/iu);
    expect(sql).toMatch(/primary_epoch IS NOT NULL[\s\S]*reported_per_lease_seq IS NOT NULL/iu);
    expect(sql).toMatch(/edge_replay_records_accepted_grant_seq_uidx/iu);
    expect(sql).toMatch(/guard_offline_grant_replay_monotonicity/iu);
    expect(sql).toMatch(/NEW\.last_seq <> 0/iu);
    expect(sql).toMatch(/NEW\.last_seq <> OLD\.last_seq \+ 1/iu);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(
      /GRANT UPDATE \(last_seq, updated_at\) ON TABLE offline_grant_replay_state TO laundry_app/iu,
    );
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE edge_replay_records FROM laundry_app/iu,
    );
  });

  it("adds immutable signed print dispatch and monotonic device receipt settlement", () => {
    const sql = readFileSync(join(migrationsDir, "0034_signed_print_dispatch.sql"), "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS snapshot_json jsonb/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS snapshot_sha256 char\(64\)/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS snapshot_purged_at timestamptz/iu);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS printer_kind text GENERATED ALWAYS AS \(kind\)/iu,
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ticket_nonce uuid/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS capability_json jsonb/iu);
    expect(sql).toMatch(/print_jobs_signed_snapshot_chk/iu);
    expect(sql).toMatch(/print_jobs_dispatch_shape_chk/iu);
    expect(sql).toMatch(/print_jobs_receipt_shape_chk/iu);
    expect(sql).toMatch(
      /snapshot_json IS NOT NULL\s+AND snapshot_sha256 IS NOT NULL\s+AND snapshot_purged_at IS NULL\s+AND jsonb_typeof\(snapshot_json\)/iu,
    );
    expect(sql).toMatch(
      /ticket_nonce IS NOT NULL\s+AND capability_json IS NOT NULL\s+AND jsonb_typeof\(capability_json\)/iu,
    );
    expect(sql).toMatch(
      /dispatch_issued_at IS NOT NULL\s+AND dispatch_expires_at IS NOT NULL\s+AND dispatch_expires_at > dispatch_issued_at/iu,
    );
    expect(sql).toMatch(
      /receipt_seq IS NOT NULL[\s\S]+receipt_result IS NOT NULL[\s\S]+receipt_json IS NOT NULL[\s\S]+receipt_envelope_sha256 IS NOT NULL/iu,
    );
    expect(sql).toMatch(/print_jobs_device_unsettled_uidx/iu);
    expect(sql).toMatch(
      /snapshot_json IS NULL AND snapshot_sha256 IS NULL AND snapshot_purged_at IS NULL/iu,
    );
    expect(sql).toMatch(
      /snapshot_json IS NULL AND snapshot_purged_at IS NOT NULL[\s\S]+status IN \('done', 'failed', 'uncertain'\)/iu,
    );
    expect(sql).toMatch(/print_jobs_source_job_fk_idx/iu);
    expect(sql).toMatch(/print_jobs_dispatch_device_fk_idx/iu);
    expect(sql).toMatch(/print_jobs_dispatch_staff_fk_idx/iu);
    expect(sql).toMatch(/print_jobs_order_privacy_idx/iu);
    expect(sql).toMatch(/guard_print_job_dispatch_immutability/iu);
    expect(sql).toMatch(/print dispatch binding is immutable/iu);
    expect(sql).toMatch(/print snapshot is immutable except for terminal privacy purge/iu);
    expect(sql).toMatch(/print receipt settlement is immutable/iu);
    expect(sql).toMatch(/guard_print_receipt_head_monotonicity/iu);
    expect(sql).toMatch(/NEW\.last_seq <> OLD\.last_seq \+ 1/iu);
    expect(sql).toMatch(/status IN \('queued', 'printing', 'done', 'failed', 'uncertain'\)/iu);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS print_device_receipt_heads/iu);
    expect(sql).toMatch(/last_seq bigint NOT NULL/iu);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/REVOKE UPDATE ON TABLE print_jobs FROM laundry_app/iu);
    expect(sql).toMatch(/GRANT UPDATE \([^)]+\) ON TABLE print_jobs TO laundry_app/isu);
    expect(sql).toMatch(
      /GRANT UPDATE \(last_seq, updated_at\) ON TABLE print_device_receipt_heads TO laundry_app/iu,
    );
    expect(sql).not.toMatch(/GRANT[^;]*(?:DELETE|TRUNCATE)[^;]*print_device_receipt_heads/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION customer_privacy_status/iu);
    expect(sql).toMatch(/print_job\.status IN \('queued', 'printing'\)/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION customer_privacy_export/iu);
    expect(sql).toMatch(/print_job\.snapshot_json/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION customer_privacy_anonymize/iu);
    expect(sql).toMatch(/SET snapshot_json = NULL,[\s\S]+snapshot_purged_at = requested_at/iu);
  });

  it("adds a durable monotonic sequence for deterministic payment ledger order", () => {
    const sql = readFileSync(join(migrationsDir, "0031_payment_ledger_sequence.sql"), "utf8");

    expect(sql).toMatch(
      /CREATE SEQUENCE IF NOT EXISTS public\.payments_ledger_seq_seq\s+AS bigint/iu,
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ledger_seq bigint/iu);
    expect(sql).toMatch(/row_number\(\) OVER \(ORDER BY payment\.at, payment\.id\)/iu);
    expect(sql).toMatch(
      /ALTER COLUMN ledger_seq\s+SET DEFAULT nextval\('public\.payments_ledger_seq_seq'::regclass\)/iu,
    );
    expect(sql).toMatch(
      /setval\(\s*'public\.payments_ledger_seq_seq'::regclass,[\s\S]*max\(ledger_seq\)[\s\S]*EXISTS/iu,
    );
    expect(sql).toMatch(/ALTER COLUMN ledger_seq SET NOT NULL/iu);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS payments_ledger_seq_uidx\s+ON public\.payments \(ledger_seq\)/iu,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS payments_order_ledger_seq_idx\s+ON public\.payments \(org_id, store_id, order_id, ledger_seq\)/iu,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON SEQUENCE public\.payments_ledger_seq_seq FROM PUBLIC, laundry_app/iu,
    );
    expect(sql).toMatch(/GRANT USAGE ON SEQUENCE public\.payments_ledger_seq_seq TO laundry_app/iu);
    expect(sql).not.toMatch(
      /GRANT (?:SELECT|UPDATE|ALL)[^;]*ON SEQUENCE public\.payments_ledger_seq_seq TO laundry_app/iu,
    );
  });
});
