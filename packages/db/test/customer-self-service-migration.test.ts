import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "migrations",
    "0061_customer_self_service.sql",
  ),
  "utf8",
);

describe("0061 customer self-service migration", () => {
  it("defaults the portal off and stores only hashed short-lived session authority", () => {
    expect(migration).toMatch(/customer_portal boolean NOT NULL DEFAULT false/iu);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.customer_portal_sessions/iu);
    expect(migration).toMatch(/session_hash char\(64\)/iu);
    expect(migration).toMatch(/csrf_hash char\(64\)/iu);
    expect(migration).toMatch(/authority_hash char\(64\)/iu);
    expect(migration).toMatch(/requested_authority_hash !~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(migration).toMatch(/expires_at <= created_at \+ interval '15 minutes'/iu);
    expect(migration).not.toMatch(/password|refresh_token|raw_token/iu);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.customer_portal_sessions/iu);
    expect(migration).toMatch(
      /customer_portal_session_validate\(uuid, text, text\).*laundry_app/isu,
    );
    expect(migration).toMatch(
      /customer_canonical_root\(excess_session\.customer_id\) = canonical_customer[\s\S]*OFFSET 4/iu,
    );
    expect(migration).toMatch(/customer_portal_cap_sessions_after_merge[\s\S]*OFFSET 5/iu);
    expect(migration).toMatch(/REVOKE UPDATE ON TABLE public\.customers FROM laundry_app/iu);
    expect(migration).toMatch(/GRANT UPDATE \([^)]+\) ON TABLE public\.customers TO laundry_app/iu);
    expect(migration).not.toMatch(
      /GRANT UPDATE \([^)]*merged_(?:into_id|at)[^)]*\) ON TABLE public\.customers/iu,
    );
    const mergeCapFunction = migration.match(
      /CREATE OR REPLACE FUNCTION public\.customer_portal_cap_sessions_after_merge\(\)[\s\S]*?\$\$;/iu,
    )?.[0];
    expect(mergeCapFunction).toBeDefined();
    expect(mergeCapFunction).not.toMatch(/pg_advisory_xact_lock/iu);
    expect(migration).not.toMatch(
      /portal_session\.customer_id = canonical_customer[\s\S]*count\(\*\).*>= 5/iu,
    );
  });

  it("projects existing authorities through canonical-customer security-barrier views", () => {
    for (const view of [
      "customer_portal_orders",
      "customer_portal_order_lines",
      "customer_portal_payments",
      "customer_portal_garments",
      "customer_portal_garment_progress",
    ]) {
      expect(migration).toMatch(new RegExp(`VIEW public\\.${view}[\\s\\S]*security_barrier`, "iu"));
    }
    expect(migration).toMatch(/customer_canonical_group/iu);
    expect(migration).toMatch(/current_setting\('app\.customer_id'/iu);
    expect(migration).not.toMatch(
      /CREATE TABLE[^;]+customer_portal_(?:orders|receipts|garments)/iu,
    );
  });

  it("keeps minimal access evidence immutable and omits PII and staff details", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.customer_portal_access_log/iu);
    expect(migration).toMatch(/customer_portal_access_log_append_only_trg/iu);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    const accessTable = migration.match(
      /CREATE TABLE IF NOT EXISTS public\.customer_portal_access_log[\s\S]*?\n\);/iu,
    )?.[0];
    expect(accessTable).toBeDefined();
    expect(accessTable).not.toMatch(
      /\b(?:phone|customer_name|note|staff_id|ip_address|user_agent)\b/iu,
    );
    expect(migration).toMatch(/GRANT INSERT ON TABLE public\.customer_portal_access_log/iu);
  });
});
