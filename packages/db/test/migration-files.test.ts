import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

describe("packages/db migration file inventory", () => {
  it("ships formal SQL migrations ordered 0001 → 0004", () => {
    const sqlFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    expect(sqlFiles).toEqual([
      "0001_roles.sql",
      "0002_m1_identity_platform.sql",
      "0003_rls_and_grants.sql",
      "0004_auth_lookup_functions.sql",
    ]);
  });

  it("prefixes are zero-padded four-digit sequence numbers", () => {
    const sqlFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const prefixes = sqlFiles.map((name) => name.slice(0, 4));
    expect(prefixes).toEqual(["0001", "0002", "0003", "0004"]);
    expect([...prefixes].sort()).toEqual(prefixes);
  });
});
