import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");
const readMigration = (): string =>
  readFileSync(join(migrationsDir, "0054_delivery_policy.sql"), "utf8");

describe("0054 delivery policy migration", () => {
  it("creates a bounded current-store policy projection with tenant RLS", () => {
    const sql = readMigration();

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.delivery_policies/iu);
    expect(sql).toMatch(/PRIMARY KEY \(org_id, store_id\)/iu);
    expect(sql).toMatch(/service_areas_json jsonb NOT NULL DEFAULT '\[\]'::jsonb/iu);
    expect(sql).toMatch(/weekly_windows_json jsonb NOT NULL DEFAULT '\[\]'::jsonb/iu);
    expect(sql).toMatch(/delivery_service_areas_are_valid\(service_areas_json\)/iu);
    expect(sql).toMatch(/delivery_weekly_windows_are_valid\(weekly_windows_json, slot_minutes\)/iu);
    expect(sql).toMatch(/delivery_policy_json_exact_keys/iu);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/current_setting\('app\.org_id', true\)/iu);
    expect(sql).toMatch(/current_setting\('app\.store_id', true\)/iu);
  });

  it("allows audited upserts but denies destructive app access", () => {
    const sql = readMigration();

    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE public\.delivery_policies TO laundry_app/iu,
    );
    expect(sql).toMatch(
      /REVOKE DELETE, TRUNCATE ON TABLE public\.delivery_policies FROM laundry_app/iu,
    );
    expect(sql).toMatch(/updated_by_staff_id uuid NOT NULL/iu);
    expect(sql).toMatch(/CREATE TRIGGER delivery_policy_write_guard_trg/iu);
    expect(sql).toMatch(/NEW\.version <> OLD\.version \+ 1/iu);
    expect(sql).toMatch(/NEW\.org_id IS DISTINCT FROM OLD\.org_id/iu);
    expect(sql).toMatch(/current_setting\('app\.staff_id', true\)/iu);
    expect(sql).toMatch(/NEW\.updated_at := db_now/iu);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_delivery_policy_idempotency_uidx[\s\S]*command = 'delivery\.policy\.set'/iu,
    );
  });

  it("does not enable delivery or introduce customer, address or reservation state", () => {
    const sql = readMigration();

    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?store_features/iu);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?store_features/iu);
    expect(sql).not.toMatch(/customer_id|address_text|reservation_id|capacity_hold_id/iu);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|TRUNCATE\s+TABLE/iu);
  });
});
