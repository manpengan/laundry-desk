import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

describe("packages/db migration file inventory", () => {
  it("ships formal SQL migrations ordered 0001 → 0010", () => {
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
    ]);
    expect([...prefixes].sort()).toEqual(prefixes);
  });
});
