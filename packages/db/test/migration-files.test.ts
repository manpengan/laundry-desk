import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

describe("packages/db migration file inventory", () => {
  it("ships formal SQL migrations ordered 0001 → 0017", () => {
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
});
