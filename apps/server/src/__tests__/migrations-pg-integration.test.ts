/**
 * Real migration integration gate. It is opt-in for ordinary unit runs and is
 * made mandatory by .github/workflows/v2-integration.yml.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";

const execFileAsync = promisify(execFile);
const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const migrationsDir = join(repoRoot, "packages", "db", "src", "migrations");
const migrateScript = join(repoRoot, "tools", "compose", "migrate-v2.sh");

test(
  "real PG migration runner applies every migration twice without rewriting history",
  { skip: urls === null },
  async () => {
    assert.ok(urls);

    await execFileAsync("bash", [migrateScript], { cwd: repoRoot, env: process.env });
    await execFileAsync("bash", [migrateScript], { cwd: repoRoot, env: process.env });

    const expected = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const pool = createPgPool({ connectionString: urls.admin });
    try {
      const applied = await pool.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM laundry_schema_migrations ORDER BY filename",
      );
      assert.deepEqual(
        applied.rows.map((row) => row.filename),
        expected,
      );
      assert.ok(applied.rows.every((row) => /^[a-f0-9]{64}$/u.test(row.checksum)));

      const role = await pool.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'laundry_app'",
      );
      assert.equal(role.rows[0]?.rolbypassrls, false);
    } finally {
      await pool.end();
    }
  },
);
