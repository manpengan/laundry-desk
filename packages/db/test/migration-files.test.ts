import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

describe("packages/db migration file inventory", () => {
  it("ships formal SQL migrations ordered 0001 → 0016", () => {
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
      "0016_order_hold_lifecycle.sql",
    ]);
  });

  it("prefixes are zero-padded four-digit sequence numbers", () => {
    const sqlFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const prefixes = sqlFiles.map((name) => name.slice(0, 4));
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
    ]);
    expect([...prefixes].sort()).toEqual(prefixes);
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

  it("persists the frozen open-status order hold marker after production hardening", () => {
    const sql = readFileSync(join(migrationsDir, "0016_order_hold_lifecycle.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS hold_reason text/iu);
    expect(sql).toMatch(/orders_hold_reason_length_chk/iu);
    expect(sql).toMatch(/orders_held_by_staff_fk/iu);
  });
});
