import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertExpandFriendlyMigrations,
  findDestructiveSql,
  isExpandFriendlyMigration,
} from "../src/migration-guard.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

const readMigrations = (): ReadonlyArray<Readonly<{ file: string; sql: string }>> => {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return files.map((file) => ({
    file,
    sql: readFileSync(join(migrationsDir, file), "utf8"),
  }));
};

describe("destructive migration static reject", () => {
  it("flags DROP TABLE / TRUNCATE / DROP COLUMN snippets", () => {
    expect(findDestructiveSql("x.sql", "DROP TABLE orgs;")).toHaveLength(1);
    expect(findDestructiveSql("x.sql", "TRUNCATE audit_log;")).toHaveLength(1);
    expect(findDestructiveSql("x.sql", "ALTER TABLE t DROP COLUMN c;")).toHaveLength(1);
    expect(isExpandFriendlyMigration("CREATE TABLE t (id uuid PRIMARY KEY);")).toBe(true);
  });

  it("rejects destructive SQL via assertExpandFriendlyMigrations", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: "bad.sql", sql: "DROP TABLE foo;" }]),
    ).toThrow(/Destructive migration SQL rejected/u);
  });

  it("ships only expand-friendly M1+M2 SQL migrations", () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    expect(migrations.map((item) => item.file)).toEqual([
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
    ]);
    expect(() => assertExpandFriendlyMigrations(migrations)).not.toThrow();
  });

  it("migration SQL encodes roles, matrix tables, session tables, and audit append grants", () => {
    const migrations = readMigrations();
    const combined = migrations.map((item) => item.sql).join("\n");

    expect(combined).toMatch(/CREATE ROLE laundry_owner/iu);
    expect(combined).toMatch(/CREATE ROLE laundry_app/iu);
    expect(combined).toMatch(/NOBYPASSRLS/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS orgs/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS sessions/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS refresh_tokens/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS pin_lockouts/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS orders/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS order_lines/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS garments/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS ticket_counters/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS catalog_items/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS payments/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS print_jobs/iu);
    expect(combined).toMatch(/CREATE TABLE IF NOT EXISTS customers/iu);
    expect(combined).toMatch(/ADD COLUMN IF NOT EXISTS args_hash/iu);
    expect(combined).toMatch(/ADD COLUMN IF NOT EXISTS entity_versions/iu);
    expect(combined).toMatch(/ADD COLUMN IF NOT EXISTS idempotency_key/iu);
    expect(combined).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(combined).toMatch(/GRANT SELECT, INSERT ON TABLE audit_log TO laundry_app/iu);
    expect(combined).toMatch(/GRANT SELECT, INSERT ON TABLE payments TO laundry_app/iu);
    expect(combined).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE print_jobs TO laundry_app/iu);
    expect(combined).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE customers TO laundry_app/iu);
    expect(combined).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pin_lockouts TO laundry_app/iu,
    );
    expect(combined).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orders TO laundry_app/iu,
    );
    expect(combined).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE garments TO laundry_app/iu,
    );
    expect(combined).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE catalog_items TO laundry_app/iu,
    );
    expect(combined).not.toMatch(/GRANT[^;]*UPDATE[^;]*audit_log/iu);
    expect(combined).not.toMatch(/GRANT[^;]*DELETE[^;]*audit_log/iu);
    expect(combined).not.toMatch(/GRANT[^;]*UPDATE[^;]*payments/iu);
    expect(combined).not.toMatch(/GRANT[^;]*DELETE[^;]*payments/iu);
    expect(combined).not.toMatch(/GRANT[^;]*DELETE[^;]*print_jobs/iu);
    expect(combined).not.toMatch(/GRANT[^;]*DELETE[^;]*customers/iu);
    expect(combined).not.toMatch(/dialect\s*[:=]\s*['"]sqlite['"]/iu);
    expect(combined.toLowerCase().includes("better" + "-sqlite3")).toBe(false);
  });
});
