/**
 * Static guard: every REFERENCES target must already exist.
 *
 * A migration naming a relation that was never created only fails when it runs
 * against a real database — the file-inventory tests read text, and every unit
 * suite skips PostgreSQL by default. Migration 0036 shipped
 * `REFERENCES staff (org_id, id)` against a table actually called `staffs`, and
 * the entire local workspace check stayed green; only the CI integration job
 * caught it. This test moves that failure back to the laptop.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

const readMigrations = (): ReadonlyArray<Readonly<{ file: string; sql: string }>> =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(migrationsDir, file), "utf8") }));

/** Strip `--` line comments so a table named in prose is not treated as SQL. */
function stripComments(sql: string): string {
  return sql
    .split(/\r?\n/u)
    .map((line) => {
      const marker = line.indexOf("--");
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join("\n");
}

function createdTables(sql: string): readonly string[] {
  const matches = sql.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/giu,
  );
  return [...matches].map((match) => match[1]!.toLowerCase());
}

function referencedTables(sql: string): readonly string[] {
  const matches = sql.matchAll(/REFERENCES\s+(?:"?public"?\.)?"?(\w+)"?/giu);
  return [...matches].map((match) => match[1]!.toLowerCase());
}

describe("packages/db migration relation references", () => {
  it("only references tables an earlier or same migration creates", () => {
    const known = new Set<string>();
    const unresolved: string[] = [];

    for (const migration of readMigrations()) {
      const sql = stripComments(migration.sql);
      // Same-file first: a table may be created and referenced in one migration.
      for (const table of createdTables(sql)) known.add(table);
      for (const table of referencedTables(sql)) {
        if (!known.has(table)) unresolved.push(`${migration.file}: REFERENCES ${table}`);
      }
    }

    expect(unresolved).toEqual([]);
  });

  it("catches a reference to a table that is never created", () => {
    // Proves the check above can fail; otherwise a broken regex would make it
    // pass forever — the exact shape of green that let 0036 through.
    const sql =
      "CREATE TABLE a (id uuid PRIMARY KEY);\nCREATE TABLE b (a_id uuid REFERENCES aa (id));";
    const known = new Set(createdTables(stripComments(sql)));
    expect(known.has("a")).toBe(true);
    expect(referencedTables(stripComments(sql))).toEqual(["aa"]);
    expect(known.has("aa")).toBe(false);
  });

  it("ignores a relation named only inside a comment", () => {
    const sql = "-- REFERENCES ghost_table explains why\nCREATE TABLE a (id uuid PRIMARY KEY);";
    expect(referencedTables(stripComments(sql))).toEqual([]);
  });
});
