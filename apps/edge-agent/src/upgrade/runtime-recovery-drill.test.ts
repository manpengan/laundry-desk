import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  RUNTIME_RECOVERY_DRILL_SCENARIOS,
  runRuntimeRecoveryDrill,
} from "./runtime-recovery-drill.js";

const execFileAsync = promisify(execFile);

test("production-isomorphic update recovery drill closes the full interruption matrix", async () => {
  const report = await runRuntimeRecoveryDrill();
  assert.deepEqual(report, {
    ok: true,
    scenarios: RUNTIME_RECOVERY_DRILL_SCENARIOS,
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.scenarios), true);
});

test("recovery drill CLI emits only the stable success sentinel", async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const result = await execFileAsync(process.execPath, [
    join(directory, "runtime-recovery-drill-cli.js"),
  ]);
  assert.equal(result.stdout, "UPDATE_RECOVERY_DRILL_OK\n");
  assert.equal(result.stderr, "");
});
