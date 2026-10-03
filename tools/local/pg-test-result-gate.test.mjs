import assert from "node:assert/strict";
import test from "node:test";
import { assertPgTestResult } from "./pg-test-result-gate.mjs";

const nativeName =
  "Windows native DPAPI survives KMS instance restart and rejects another identity";
const log = (rows, skipped = 0, failed = 0) =>
  `${rows.join("\n")}\n# tests ${rows.length}\n# fail ${failed}\n# cancelled 0\n# skipped ${skipped}\n`;

test("PG gate accepts completed database tests and only the named Windows case on other platforms", () => {
  assert.doesNotThrow(() => assertPgTestResult(log(["ok 1 - actual PostgreSQL"]), "linux"));
  for (const platform of ["linux", "darwin"])
    assert.doesNotThrow(() =>
      assertPgTestResult(
        log(["ok 1 - actual PostgreSQL", `ok 2 - ${nativeName} # SKIP`], 1),
        platform,
      ),
    );
  assert.throws(() => assertPgTestResult(log([`ok 1 - ${nativeName} # SKIP`], 1), "win32"));
});

test("PG gate rejects missing database coverage, hidden skips, duplicate native skips and failures", () => {
  for (const value of [
    log(["ok 1 - actual PostgreSQL # SKIP"], 1),
    log(["ok 1 - actual PostgreSQL"], 1),
    log([`ok 1 - ${nativeName} # SKIP`], 0),
    log([`ok 1 - ${nativeName} # SKIP`, `ok 2 - ${nativeName} # SKIP`], 2),
    log([`ok 1 - ${nativeName} # SKIP`], 1),
    log(["not ok 1 - actual PostgreSQL"], 0, 1),
    log([]),
    "partial test output",
  ])
    assert.throws(() => assertPgTestResult(value, "linux"));
});
