import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runtimeEntryFixture } from "../../../tools/windows-runtime/runtime-entry-test-fixture.mjs";
import { packageRuntimeEntry } from "../../../tools/windows-runtime/package-runtime-entry.mjs";
import { inspectRuntimeMaintenanceBinding, loadAsar } from "./inspect-runtime-maintenance.mjs";
import { stageRuntimeMaintenance } from "./stage-runtime-maintenance.mjs";

test("package inspection rejects a null, stale or modified ASAR binding and detached Runtime manifest", async (t) => {
  const fixture = await runtimeEntryFixture(t);
  const entry = await packageRuntimeEntry(fixture);
  const code = join(fixture.root, "code");
  const bindingPath = join(code, "dist/maintenance/runtime-binding.js");
  await mkdir(join(code, "dist/maintenance"), { recursive: true });
  await stageRuntimeMaintenance({
    packageRoot: code,
    entryDirectory: fixture.output,
    expectedGitSha: fixture.sourceSha,
  });
  const original = await readFile(bindingPath, "utf8");
  const pack = async (name, binding) => {
    await writeFile(bindingPath, binding);
    const asarPath = join(fixture.root, `${name}.asar`);
    await loadAsar().createPackage(code, asarPath);
    return { asarPath, entryDirectory: fixture.output, expectedGitSha: fixture.sourceSha };
  };
  const valid = await pack("valid", original);
  assert.deepEqual(await inspectRuntimeMaintenanceBinding(valid), {
    source_git_sha: fixture.sourceSha,
    manifest_sha256: fixture.manifestSha,
    entry_sha256: entry.entry_sha256,
  });
  for (const [name, value] of [
    ["null", "export const RUNTIME_MAINTENANCE_BINDING = null;\n"],
    ["stale", original.replace(fixture.manifestSha, "f".repeat(64))],
    ["modified", `${original}throw new Error('must never execute');\n`],
  ])
    await assert.rejects(
      inspectRuntimeMaintenanceBinding(await pack(name, value)),
      /PACKAGED_MISMATCH/u,
    );
  await assert.rejects(
    inspectRuntimeMaintenanceBinding({ ...valid, expectedGitSha: "b".repeat(40) }),
    /RELEASE_INVALID/u,
  );
  await writeFile(join(fixture.output, "payload/runtime-payload.json"), "{}");
  await assert.rejects(inspectRuntimeMaintenanceBinding(valid), /MANIFEST_DIGEST_INVALID/u);
});
