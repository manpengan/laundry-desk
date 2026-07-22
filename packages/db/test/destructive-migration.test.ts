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

  it("ships only expand-friendly M1 SQL migrations", () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    expect(migrations.map((item) => item.file)).toEqual([
      "0001_roles.sql",
      "0002_m1_identity_platform.sql",
      "0003_rls_and_grants.sql",
      "0004_auth_lookup_functions.sql",
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
    expect(combined).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(combined).toMatch(/GRANT SELECT, INSERT ON TABLE audit_log TO laundry_app/iu);
    expect(combined).not.toMatch(/GRANT[^;]*UPDATE[^;]*audit_log/iu);
    expect(combined).not.toMatch(/GRANT[^;]*DELETE[^;]*audit_log/iu);
    expect(combined).not.toMatch(/dialect\s*[:=]\s*['"]sqlite['"]/iu);
    expect(combined.toLowerCase().includes("better" + "-sqlite3")).toBe(false);
  });
});
