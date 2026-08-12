import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

const tableBody = (sql: string, table: string): string => {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "iu"),
  );
  expect(match, `missing ${table} table`).not.toBeNull();
  return match?.[1] ?? "";
};

describe("0052 notification delivery outbox migration", () => {
  it("adds privacy-safe leased delivery state and append-only evidence", () => {
    const sql = readFileSync(join(migrationsDir, "0052_notification_delivery_outbox.sql"), "utf8");

    for (const table of [
      "notification_templates",
      "notification_delivery_batches",
      "notification_deliveries",
      "notification_delivery_attempts",
      "notification_delivery_receipts",
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "iu"));
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`, "iu"),
      );
    }

    const deliveryColumns = tableBody(sql, "notification_deliveries");
    expect(deliveryColumns).toMatch(/recipient_hmac char\(64\)/iu);
    expect(deliveryColumns).toMatch(/message_sha256 char\(64\)/iu);
    expect(deliveryColumns).toMatch(/lease_token uuid/iu);
    expect(deliveryColumns).toMatch(/reserved_cost_cents integer/iu);
    expect(deliveryColumns).toMatch(/provider_outcome_pending boolean/iu);
    expect(deliveryColumns).toMatch(/attempt_count BETWEEN 0 AND 5/iu);
    expect(deliveryColumns).not.toMatch(/phone|message_body|provider_payload|response_body/iu);

    expect(sql).toMatch(/code = 'pickup_reminder_v1'/iu);
    expect(sql).toMatch(/channel = 'sms'/iu);
    expect(sql).toMatch(
      /commissioning_seed_notification_template_trg[\s\S]*AFTER INSERT ON public\.local_bootstrap_metadata/iu,
    );
    expect(sql).not.toMatch(/AFTER INSERT ON public\.orgs/iu);
    expect(sql).toMatch(/recipient_count BETWEEN 1 AND 50/iu);
    expect(sql).toMatch(/estimated_cost_cents <= max_cost_cents/iu);
    expect(sql).toMatch(/status = 'queued'[\s\S]*attempt_count = 0/iu);
    expect(sql).toMatch(/status = 'sending'[\s\S]*lease_until > claimed_at/iu);
    expect(sql).toMatch(/status = 'delivered'[\s\S]*delivered_at IS NOT NULL/iu);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_order_uidx\s+ON public\.notification_deliveries \(org_id, store_id, order_id\);/iu,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_notification_idempotency_uidx[\s\S]*command = 'notification\.delivery_batch\.enqueue'/iu,
    );

    expect(sql).toMatch(
      /guard_notification_delivery[\s\S]*session_org IS DISTINCT FROM NEW\.org_id[\s\S]*session_store IS DISTINCT FROM NEW\.store_id[\s\S]*FROM orders[\s\S]*FOR SHARE/iu,
    );
    expect(sql).toMatch(/MESSAGE = 'NOTIFICATION_INITIAL_STATE_INVALID'/iu);
    expect(sql).toMatch(/MESSAGE = 'NOTIFICATION_STATUS_INVALID'/iu);
    expect(sql).toMatch(/MESSAGE = 'NOTIFICATION_LEASE_ACTIVE'/iu);
    expect(sql).toMatch(/MESSAGE = 'NOTIFICATION_ATTEMPT_INVALID'/iu);
    expect(sql).toMatch(/MESSAGE = 'NOTIFICATION_FINGERPRINT_IMMUTABLE'/iu);
    expect(sql).toMatch(
      /notification_recipient_matches[\s\S]*session_org IS DISTINCT FROM requested_org[\s\S]*session_store IS DISTINCT FROM requested_store[\s\S]*customer_phone_hmac/iu,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.notification_recipient_matches\(uuid, uuid, uuid, uuid, text\)[\s\S]*TO laundry_app/iu,
    );

    expect(sql).toMatch(
      /cancel_notification_delivery_for_privacy[\s\S]*MESSAGE = 'CUSTOMER_NOTIFICATION_IN_FLIGHT'[\s\S]*SET status = CASE[\s\S]*recipient_hmac = NULL[\s\S]*message_sha256 = NULL/iu,
    );
    expect(sql).toMatch(
      /delivery\.status = 'sending'\s+AND delivery\.lease_until > statement_timestamp\(\)/iu,
    );
    expect(sql).not.toMatch(
      /provider_outcome_pending[\s\S]{0,120}CUSTOMER_NOTIFICATION_IN_FLIGHT/iu,
    );
    expect(sql).toMatch(
      /BEFORE UPDATE OF customer_pii_purged_at ON public\.orders[\s\S]*cancel_notification_delivery_for_privacy/iu,
    );

    for (const table of [
      "notification_templates",
      "notification_delivery_batches",
      "notification_delivery_attempts",
      "notification_delivery_receipts",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `BEFORE UPDATE OR DELETE ON public\\.${table}[\\s\\S]*reject_notification_evidence_mutation`,
          "iu",
        ),
      );
    }
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.notification_delivery_attempts/iu,
    );
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.notification_delivery_receipts/iu,
    );
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|DROP\s+CONSTRAINT|(?:^|\n)\s*TRUNCATE\b/iu);

    const exportStart = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.customer_notification_privacy_export",
    );
    const exportEnd = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.customer_privacy_export(",
      exportStart,
    );
    expect(exportStart).toBeGreaterThan(-1);
    expect(exportEnd).toBeGreaterThan(exportStart);
    const notificationExport = sql.slice(exportStart, exportEnd);
    expect(notificationExport).toMatch(/notification_delivery_count/iu);
    expect(notificationExport).toMatch(/notification_deliveries_truncated/iu);
    expect(notificationExport).toMatch(/attempt_no[\s\S]*receipt_count/iu);
    expect(notificationExport).not.toMatch(
      /recipient_hmac|message_sha256|provider_ref_sha256|receipt_sha256/iu,
    );
    expect(sql).toMatch(
      /base_payload \|\| customer_notification_privacy_export\(requested_customer_id\)/iu,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.customer_notification_privacy_export\(uuid\)[\s\S]*FROM PUBLIC, laundry_app/iu,
    );
  });
});
