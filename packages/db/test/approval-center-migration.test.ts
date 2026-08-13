import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertExpandFriendlyMigrations } from "../src/migration-guard.js";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "migrations",
    "0068_ai_approval_center.sql",
  ),
  "utf8",
);

describe("0068 AI approval center migration", () => {
  it("remains expand-only and tenant/store forced-RLS", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: "0068_ai_approval_center.sql", sql: migration }]),
    ).not.toThrow();
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(migration).toMatch(/app\.org_id/iu);
    expect(migration).toMatch(/app\.store_id/iu);
  });

  it("freezes the pending R4 authority and excludes R5", () => {
    expect(migration).toMatch(/pending_row\.effective_risk <> 'R4'/iu);
    expect(migration).toMatch(/pending_row\.args_hash/iu);
    expect(migration).toMatch(/pending_row\.entity_versions_json/iu);
    expect(migration).toMatch(/pending_row\.idempotency_key/iu);
    expect(migration).not.toMatch(/effective_risk\s*(?:=|<>)\s*'R5'/iu);
  });

  it("enforces another current admin, version authority and single consumption", () => {
    expect(migration).toMatch(/requester_staff_id = authority\.staff_id/iu);
    expect(migration).toMatch(/role_row\.role = 'admin'/iu);
    expect(migration).toMatch(/requester_permission_version/iu);
    expect(migration).toMatch(/decided_by_permission_version/iu);
    expect(migration).toMatch(/WHERE approval_ref = requested_ref AND status = 'approved'/iu);
    expect(migration).toMatch(/approval request already consumed/iu);
  });

  it("closes direct application writes behind database-authoritative functions", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.ai_approval_requests FROM PUBLIC, laundry_app/iu,
    );
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.ai_approval_requests TO laundry_app/iu,
    );
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)/iu);
    expect(migration).toMatch(/SECURITY DEFINER/iu);
    expect(migration).toMatch(/SET search_path = pg_catalog, public/iu);
  });
});
