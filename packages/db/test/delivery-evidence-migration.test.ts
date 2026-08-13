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
    "0058_delivery_evidence.sql",
  ),
  "utf8",
);

describe("0058 delivery evidence migration", () => {
  it("creates dedicated append-only evidence and attachment metadata", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.delivery_evidence_events/iu);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.delivery_evidence_attachments/iu);
    expect(migration).toMatch(/delivery_evidence_attachment_links/iu);
    expect(migration).toMatch(/content_sha256 char\(64\)/iu);
    expect(migration).toMatch(/storage_key text NOT NULL/iu);
    expect(migration).toMatch(/delivery evidence is append-only/iu);
    expect(migration).toMatch(/BEFORE TRUNCATE/iu);
    expect(migration).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE/iu);
  });

  it("binds DB time, actor, tenant, accepted task and exact version", () => {
    expect(migration).toMatch(/statement_timestamp\(\)/iu);
    expect(migration).toMatch(/current_setting\('app\.staff_id', true\)/iu);
    expect(migration).toMatch(/task_row\.status <> 'accepted'/iu);
    expect(migration).toMatch(/task_row\.version IS DISTINCT FROM NEW\.delivery_task_version/iu);
    expect(migration).toMatch(/assignee_staff_id := actor_id/iu);
  });

  it("requires atomic pickup/return completion evidence", () => {
    expect(migration).toMatch(/guard_delivery_order_completion_evidence/iu);
    expect(migration).toMatch(/delivery order completion requires current evidence/iu);
    expect(migration).toMatch(/attachment\.kind = 'photo'/iu);
    expect(migration).toMatch(/attachment\.kind = 'signature'/iu);
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/iu);
  });

  it("exports only privacy counts and explicit retention decisions", () => {
    expect(migration).toMatch(/delivery_evidence_count/iu);
    expect(migration).toMatch(/delivery_attachment_count/iu);
    expect(migration).toMatch(/retained_operational_evidence/iu);
    expect(migration).not.toMatch(/jsonb_build_object\([\s\S]*'latitude_e7'/iu);
  });
});
