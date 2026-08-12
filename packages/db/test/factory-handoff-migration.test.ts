import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

const readMigration = (): string =>
  readFileSync(join(migrationsDir, "0053_factory_handoff_and_qc.sql"), "utf8");

const tableBody = (sql: string, table: string): string => {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "iu"),
  );
  expect(match, `missing ${table} table`).not.toBeNull();
  return match?.[1] ?? "";
};

const functionBody = (sql: string, functionName: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  expect(start, `missing ${functionName} function`).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `unterminated ${functionName} function`).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
};

describe("0053 factory handoff and QC migration", () => {
  it("adds a store-scoped manifest without replacing garment lifecycle status", () => {
    const sql = readMigration();

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS custody_state text NOT NULL DEFAULT 'store'/iu);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS active_production_batch_id uuid/iu);
    expect(sql).toMatch(
      /custody_state IN \('store', 'to_factory', 'factory', 'to_store', 'exception'\)/iu,
    );
    expect(sql).not.toMatch(/ALTER COLUMN status/iu);
    expect(sql).toMatch(
      /garments_active_production_batch_fk[\s\S]*REFERENCES public\.batch_garments \(org_id, store_id, batch_id, garment_id\)/iu,
    );
    expect(sql).toMatch(
      /active_production_batch_id IS NOT NULL[\s\S]*custody_state = 'store'[\s\S]*custody_state = 'exception' AND status = 'lost'/iu,
    );

    for (const table of [
      "production_batches",
      "batch_garments",
      "production_handoff_attempts",
      "production_handoff_attempt_items",
      "production_handoff_checkpoints",
      "production_handoff_discrepancy_resolutions",
      "garment_qc_log",
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "iu"));
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`, "iu"),
      );
      expect(sql).toMatch(new RegExp(`${table}_store_scope`, "iu"));
    }

    expect(sql).toMatch(
      /status IN \([\s\S]*'packing'[\s\S]*'store_dispatched'[\s\S]*'factory_received'[\s\S]*'factory_dispatched'[\s\S]*'store_received'[\s\S]*'cancelled'/iu,
    );
    expect(sql).toMatch(/state IN \('active', 'exception', 'completed'\)/iu);
    expect(sql).toMatch(/qc_status IN \('pending', 'pass', 'rework'\)/iu);
    expect(sql).toMatch(/expected_garment_count BETWEEN 1 AND 100/iu);
    expect(tableBody(sql, "production_batches")).toMatch(/cancel_reason_code text/iu);
    expect(sql).toMatch(
      /status = 'cancelled'[\s\S]*cancel_reason_code IN \('duplicate_batch', 'customer_request', 'operational_error'\)[\s\S]*status <> 'cancelled' AND cancel_reason_code IS NULL/iu,
    );
    expect(sql).toMatch(/WHERE state IN \('active', 'exception'\)/iu);
    expect(sql).toMatch(/factory_code ~ '\^\[A-Z0-9\]\[A-Z0-9\._-\]/iu);
    expect(sql).toMatch(/barcode !~ '\[\\u0001-\\u001F\\u007F\]'/iu);
    expect(sql).not.toMatch(/customer_(?:name|phone)|address_body|provider_payload/iu);

    for (const table of [
      "production_batches",
      "batch_garments",
      "production_handoff_attempts",
      "production_handoff_checkpoints",
      "production_handoff_discrepancy_resolutions",
      "garment_qc_log",
    ]) {
      expect(tableBody(sql, table)).toMatch(/device_id uuid NOT NULL/iu);
    }
  });

  it("constrains immutable handoff, discrepancy, and quality evidence", () => {
    const sql = readMigration();

    expect(sql).toMatch(
      /checkpoint IN \('store_dispatch', 'factory_receive', 'factory_dispatch', 'store_receive'\)/iu,
    );
    expect(sql).toMatch(/outcome IN \('matched', 'discrepancy'\)/iu);
    expect(tableBody(sql, "production_handoff_attempts")).toMatch(
      /batch_version integer NOT NULL/iu,
    );
    expect(sql).toMatch(/batch_version BETWEEN 1 AND 1000000/iu);
    expect(sql).toMatch(/expected_count BETWEEN 1 AND 100/iu);
    expect(sql).toMatch(/outcome IN \('matched', 'missing', 'unexpected'\)/iu);
    expect(sql).toMatch(/UNIQUE \(org_id, store_id, attempt_id, barcode\)/iu);
    expect(sql).toMatch(/outcome IN \('matched', 'reconciled'\)/iu);
    expect(sql).toMatch(/matched_count BETWEEN 1 AND 100/iu);
    expect(sql).toMatch(
      /resolution_code IN \('manifest_corrected', 'recount_verified', 'exception_accepted'\)/iu,
    );
    expect(sql).toMatch(
      /reason_code IN \('stain_remaining', 'damage_found', 'finish_incomplete', 'other'\)/iu,
    );
    expect(sql).toMatch(/outcome = 'rework' AND reason_code IS NOT NULL/iu);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.reject_factory_evidence_mutation/iu);
    expect(sql).toMatch(
      /guard_factory_active_customer_erasure[\s\S]*OLD\.active_production_batch_id IS NOT NULL[\s\S]*CUSTOMER_FACTORY_HANDOFF_ACTIVE/iu,
    );
    expect(sql).toMatch(
      /OLD\.customer_pii_purged_at IS NOT NULL[\s\S]*NEW\.custody_state IS DISTINCT FROM OLD\.custody_state[\s\S]*NEW\.active_production_batch_id IS DISTINCT FROM OLD\.active_production_batch_id[\s\S]*CUSTOMER_ERASED/iu,
    );
    const legacyGuard = functionBody(sql, "guard_factory_subject_write");
    const legacyBatchGuard = functionBody(sql, "assert_factory_batch_subjects_active");
    expect(legacyGuard).toMatch(/assert_factory_tenant_scope/iu);
    expect(legacyGuard).not.toMatch(/FROM (?:public\.)?(?:orders|garments)|FOR SHARE/iu);
    expect(legacyBatchGuard).toMatch(/assert_factory_tenant_scope/iu);
    expect(legacyBatchGuard).not.toMatch(/FROM (?:public\.)?(?:orders|garments)|FOR SHARE/iu);
    expect(sql).toMatch(/customer_factory_active_privacy_guard_trg/iu);
    expect(sql).toMatch(/customer_factory_subject_custody_guard_trg/iu);
    expect(sql).toMatch(/factory_subject_batch_garments_trg/iu);
    expect(sql).toMatch(/factory_subject_handoff_attempts_trg/iu);
    expect(sql).toMatch(/factory_subject_handoff_checkpoints_trg/iu);
    expect(sql).toMatch(/factory_subject_handoff_resolutions_trg/iu);
    expect(sql).toMatch(/factory_subject_garment_qc_log_trg/iu);

    for (const table of [
      "production_handoff_attempts",
      "production_handoff_attempt_items",
      "production_handoff_checkpoints",
      "production_handoff_discrepancy_resolutions",
      "garment_qc_log",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `BEFORE UPDATE OR DELETE ON public\\.${table}[\\s\\S]*reject_factory_evidence_mutation`,
          "iu",
        ),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT SELECT, INSERT ON TABLE public\\.${table} TO laundry_app`, "iu"),
      );
      expect(sql).toMatch(
        new RegExp(
          `REVOKE UPDATE, DELETE, TRUNCATE\\s+ON TABLE public\\.${table} FROM laundry_app`,
          "iu",
        ),
      );
    }

    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE public\.production_batches TO laundry_app/iu,
    );
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE public\.batch_garments TO laundry_app/iu,
    );
    expect(sql).toMatch(
      /REVOKE DELETE, TRUNCATE ON TABLE public\.production_batches FROM laundry_app/iu,
    );
    expect(sql).toMatch(
      /REVOKE DELETE, TRUNCATE ON TABLE public\.batch_garments FROM laundry_app/iu,
    );
  });

  it("enforces current-stage authority without reverse-locking batch or member parents", () => {
    const sql = readMigration();
    const batchGuard = functionBody(sql, "guard_factory_batch_write");
    const memberGuard = functionBody(sql, "guard_factory_member_write");
    const attemptGuard = functionBody(sql, "guard_factory_attempt_insert");
    const itemGuard = functionBody(sql, "guard_factory_attempt_item_insert");
    const checkpointGuard = functionBody(sql, "guard_factory_checkpoint_insert");
    const resolutionGuard = functionBody(sql, "guard_factory_resolution_insert");
    const qcGuard = functionBody(sql, "guard_factory_qc_insert");

    expect(batchGuard).toMatch(/terminal factory batch is immutable/iu);
    expect(batchGuard).toMatch(/NEW\.version <> OLD\.version \+ 1/iu);
    expect(batchGuard).toMatch(/illegal factory batch transition/iu);
    expect(batchGuard).toMatch(/same-state factory batch update lacks evidence/iu);
    expect(batchGuard).toMatch(/factory discrepancy blocks same-state batch update/iu);
    expect(batchGuard).toMatch(
      /attempt\.batch_version = OLD\.version[\s\S]*attempt\.checkpoint = required_checkpoint[\s\S]*NOT EXISTS \([\s\S]*production_handoff_discrepancy_resolutions/iu,
    );
    expect(batchGuard).toMatch(/factory batch transition lacks checkpoint evidence/iu);
    expect(batchGuard).not.toMatch(/FOR (?:UPDATE|SHARE).*orders|FOR (?:UPDATE|SHARE).*garments/iu);

    expect(memberGuard).toMatch(/factory member identity is immutable/iu);
    expect(memberGuard).toMatch(/completed factory member is immutable/iu);
    expect(memberGuard).toMatch(/invalid factory member quality transition/iu);
    expect(memberGuard).toMatch(
      /OLD\.state = 'active' AND NEW\.state = 'active'[\s\S]*NOT EXISTS \([\s\S]*garment_qc_log qc[\s\S]*qc\.outcome = NEW\.qc_status[\s\S]*qc\.inspected_at > OLD\.updated_at/iu,
    );
    expect(memberGuard).not.toMatch(/NEW\.qc_status = OLD\.qc_status/iu);
    expect(memberGuard).toMatch(/factory member must be reconciled before mark lost/iu);
    expect(memberGuard).toMatch(
      /OLD\.state = 'active' AND NEW\.state IN \('exception', 'completed'\)[\s\S]*NEW\.state = 'exception' AND subject\.status = 'lost'/iu,
    );
    expect(memberGuard).not.toMatch(/FOR UPDATE|FOR SHARE/iu);

    expect(attemptGuard).toMatch(/batch\.version INTO batch_row[\s\S]*FOR UPDATE/iu);
    expect(attemptGuard).toMatch(/NEW\.batch_version <> batch_row\.version/iu);
    expect(attemptGuard).toMatch(/factory discrepancy requires reconciliation/iu);
    expect(attemptGuard).toMatch(/factory dispatch manifest is not quality ready/iu);
    expect(attemptGuard).toMatch(
      /NEW\.checkpoint = 'factory_dispatch'[\s\S]*member\.qc_status <> 'pass'[\s\S]*garment\.custody_state <> 'factory'/iu,
    );
    expect(attemptGuard).toMatch(
      /NOT EXISTS \([\s\S]*production_handoff_discrepancy_resolutions/iu,
    );
    expect(attemptGuard).toMatch(/MAX\(attempt\.attempt_no\)/iu);
    expect(attemptGuard).toMatch(/member\.state = 'active'/iu);

    expect(itemGuard).toMatch(/attempt_row\.batch_version <> attempt_row\.current_version/iu);
    expect(itemGuard).toMatch(/unexpected barcode belongs to active manifest/iu);
    expect(itemGuard).toMatch(/subject\.state <> 'active' OR subject\.barcode <> NEW\.barcode/iu);
    expect(checkpointGuard).toMatch(/NEW\.matched_count <> evidence\.matched_count/iu);
    expect(checkpointGuard).toMatch(/reconciled checkpoint lacks resolution/iu);
    expect(resolutionGuard).toMatch(/evidence\.outcome <> 'discrepancy'/iu);
    expect(resolutionGuard).toMatch(/factory discrepancy resolution is stale/iu);
    expect(qcGuard).toMatch(/batch_row\.status <> 'factory_received'/iu);
    expect(qcGuard).toMatch(
      /attempt\.batch_version = batch_row\.version[\s\S]*attempt\.checkpoint = 'factory_dispatch'[\s\S]*factory discrepancy requires reconciliation before quality check/iu,
    );
    expect(qcGuard).toMatch(/subject\.custody_state <> 'factory'/iu);
    expect(qcGuard).toMatch(/MAX\(qc\.inspection_no\)/iu);
  });

  it("uses database clocks and deferred graph checks for multi-row projections", () => {
    const sql = readMigration();

    for (const functionName of [
      "guard_factory_batch_write",
      "guard_factory_member_write",
      "guard_factory_attempt_insert",
      "guard_factory_attempt_item_insert",
      "guard_factory_checkpoint_insert",
      "guard_factory_resolution_insert",
      "guard_factory_qc_insert",
    ]) {
      expect(functionBody(sql, functionName)).toMatch(/statement_timestamp\(\)/iu);
    }
    expect(functionBody(sql, "assert_factory_attempt_complete")).toMatch(
      /factory attempt header and items disagree/iu,
    );
    expect(functionBody(sql, "assert_factory_attempt_complete")).toMatch(
      /exact factory attempt lacks matched checkpoint/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /member_count <> batch_row\.expected_garment_count/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /exception_count <> batch_row\.exception_garment_count/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /attempt\.batch_version = batch_row\.version[\s\S]*factory checkpoint has not advanced batch authority/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /batch_row\.status = 'packing'[\s\S]*member\.qc_status <> 'pending'[\s\S]*garment\.status NOT IN \('received', 'reworked'\)/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /batch_row\.status = 'store_dispatched'[\s\S]*member\.qc_status <> 'pending'[\s\S]*garment\.status <> 'washing'/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /batch_row\.status = 'factory_received'[\s\S]*member\.qc_status = 'pending'[\s\S]*garment\.status <> 'washing'/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /member\.state = 'exception'[\s\S]*active_production_batch_id = requested_batch_id[\s\S]*garment\.status <> 'lost'[\s\S]*active_production_batch_id IS NULL[\s\S]*garment\.status = 'lost'/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /member\.state = 'active'[\s\S]*member\.state = 'exception'[\s\S]*member\.state = 'completed'/iu,
    );
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /completed_checkpoint := CASE batch_row\.status[\s\S]*checkpoint\.checkpoint = completed_checkpoint[\s\S]*item\.outcome = 'matched'[\s\S]*member\.state IS DISTINCT FROM 'completed'[\s\S]*member\.state IS DISTINCT FROM 'active'[\s\S]*item\.outcome = 'missing'[\s\S]*member\.state IS DISTINCT FROM 'exception'[\s\S]*factory checkpoint items and custody projection disagree/iu,
    );
    const batchGraph = functionBody(sql, "assert_factory_batch_graph");
    expect(batchGraph).toMatch(
      /member\.state = 'exception'[\s\S]*AND NOT EXISTS \([\s\S]*production_handoff_attempt_items item[\s\S]*production_handoff_discrepancy_resolutions resolution[\s\S]*production_handoff_checkpoints checkpoint[\s\S]*item\.garment_id = member\.garment_id[\s\S]*item\.outcome = 'missing'/iu,
    );
    expect(batchGraph).toMatch(
      /member\.state <> 'exception'[\s\S]*AND EXISTS \([\s\S]*item\.garment_id = member\.garment_id[\s\S]*item\.outcome = 'missing'[\s\S]*factory exception projection disagrees with resolved missing evidence/iu,
    );
    expect(batchGraph).not.toMatch(/FOR UPDATE|FOR SHARE/iu);
    expect(functionBody(sql, "assert_factory_batch_graph")).toMatch(
      /member\.qc_status = 'pending'[\s\S]*NOT EXISTS \([\s\S]*garment_qc_log[\s\S]*member\.qc_status = \([\s\S]*ORDER BY qc\.inspection_no DESC/iu,
    );
    expect(functionBody(sql, "guard_factory_qc_deferred_consistency")).toMatch(
      /factory quality evidence projection is incomplete/iu,
    );
    expect(functionBody(sql, "guard_factory_qc_deferred_consistency")).toMatch(
      /batch\.updated_at >= NEW\.inspected_at/iu,
    );

    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER factory_batch_graph_deferred_trg/iu);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER factory_member_graph_deferred_trg/iu);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER factory_garment_graph_deferred_trg/iu);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER factory_attempt_graph_deferred_trg/iu);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER factory_qc_projection_deferred_trg/iu);
    expect(sql).toMatch(/DEFERRABLE INITIALLY DEFERRED/iu);
    expect(sql).toMatch(/production_handoff_attempts_current_idx/iu);
    expect(sql).toMatch(/production_handoff_attempt_items_attempt_outcome_idx/iu);
  });

  it("fixes search paths and revokes every invariant helper from public execution", () => {
    const sql = readMigration();
    for (const functionName of [
      "assert_factory_tenant_scope",
      "guard_factory_batch_write",
      "guard_factory_member_write",
      "guard_factory_attempt_insert",
      "guard_factory_attempt_item_insert",
      "guard_factory_checkpoint_insert",
      "guard_factory_resolution_insert",
      "guard_factory_qc_insert",
      "assert_factory_attempt_complete",
      "assert_factory_batch_graph",
      "guard_factory_deferred_consistency",
      "guard_factory_qc_deferred_consistency",
    ]) {
      expect(functionBody(sql, functionName)).toMatch(
        /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/iu,
      );
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}\\(`, "iu"));
    }
  });

  it("extends the bounded canonical privacy export with safe handoff facts", () => {
    const sql = readMigration();
    const exportStart = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.customer_factory_handoff_privacy_export",
    );
    const exportEnd = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.customer_privacy_export(",
      exportStart,
    );

    expect(exportStart).toBeGreaterThan(-1);
    expect(exportEnd).toBeGreaterThan(exportStart);
    const exportSql = sql.slice(exportStart, exportEnd);
    expect(exportSql).toMatch(/customer_canonical_root/iu);
    expect(exportSql).toMatch(/customer_canonical_group/iu);
    expect(exportSql).toMatch(/factory_handoff_evidence/iu);
    expect(exportSql).toMatch(/factory_handoff_evidence_count/iu);
    expect(exportSql).toMatch(/factory_handoff_evidence_truncated/iu);
    expect(exportSql).toMatch(/LIMIT 1000/iu);
    expect(exportSql).toMatch(/ORDER BY[\s\S]*FOR SHARE/iu);
    expect(exportSql).not.toMatch(/customer_(?:name|phone)|recipient_hmac|message_sha256/iu);
    expect(sql).toMatch(
      /customer_privacy_export_v3_base\([\s\S]*base_payload \|\| customer_factory_handoff_privacy_export\(requested_customer_id\)/iu,
    );
  });

  it("is expand-only and replay-safe", () => {
    const sql = readMigration();

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS custody_state/iu);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.production_batches/iu);
    expect(sql).toMatch(/IF NOT EXISTS \([\s\S]*garments_custody_state_chk/iu);
    expect(sql).toMatch(/IF NOT EXISTS \([\s\S]*garments_active_production_batch_fk/iu);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|DROP\s+CONSTRAINT|(?:^|\n)\s*TRUNCATE\b/iu);
  });
});
