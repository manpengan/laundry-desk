import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeEntryFixture } from "../../../tools/windows-runtime/runtime-entry-test-fixture.mjs";
import { packageRuntimeEntry } from "../../../tools/windows-runtime/package-runtime-entry.mjs";
import { stageRuntimeMaintenance } from "./stage-runtime-maintenance.mjs";
test("packaging pins a matching release and refuses missing, stale or altered Runtime entries", async (t) => {
  const fixture = await runtimeEntryFixture(t);
  await packageRuntimeEntry(fixture);
  const root = fixture.root;
  await mkdir(join(root, "dist/maintenance"), { recursive: true });
  const options = {
    packageRoot: root,
    entryDirectory: fixture.output,
    expectedGitSha: fixture.sourceSha,
  };
  assert.equal((await stageRuntimeMaintenance(options)).enabled, true);
  const staged = join(root, "dist/maintenance/runtime-binding.js");
  const original = await readFile(staged, "utf8");
  assert.match(original, /LaundryCounterMaintenanceTrust/u);
  assert.ok(original.includes(fixture.manifestSha));
  await assert.rejects(stageRuntimeMaintenance({ packageRoot: root }), /BINDING_REQUIRED/u);
  assert.equal(await readFile(staged, "utf8"), original);
  await assert.rejects(
    stageRuntimeMaintenance({ ...options, expectedGitSha: "2".repeat(40) }),
    /RELEASE_INVALID/u,
  );
  await writeFile(join(fixture.output, "runtime-entry.ps1"), "changed");
  await assert.rejects(stageRuntimeMaintenance(options), /ENTRY_CHANGED/u);
});
test("the fixed native bootstrap fits the Windows command-line bound", async () => {
  const trust = (
    await readFile(resolve("../../tools/windows-runtime/runtime-entry-trust.ps1"), "utf8")
  ).replaceAll("LaundryRuntimeEntryTrust", "LaundryCounterMaintenanceTrust");
  const script = await readFile(resolve("src/maintenance/windows-script.ts"), "utf8");
  const source = script.slice(script.indexOf("String.raw`") + 11, script.lastIndexOf("`"));
  const prelude = "$ProgressPreference = 'SilentlyContinue'\n";
  assert.ok(script.includes(JSON.stringify(prelude).slice(1, -1)));
  const command = prelude + trust + "\n" + source;
  assert.ok(Buffer.from(command, "utf16le").toString("base64").length < 32000);
});
test("the counter looks for the Runtime under the root its installer uses", async () => {
  const installer = await readFile(
    resolve("../../tools/windows-runtime/runtime-entry-install.ps1"),
    "utf8",
  );
  const script = await readFile(resolve("src/maintenance/windows-script.ts"), "utf8");
  const rooted = "-cnotmatch '^[A-Za-z]:\\\\'";
  assert.ok(installer.includes(`$env:LOCALAPPDATA ${rooted}`));
  assert.ok(installer.includes("DirectoryPath($env:LOCALAPPDATA)"));
  assert.ok(installer.includes("Join-Path $programs 'Laundry Desk Runtime V2'"));
  assert.ok(script.includes("$local = $env:LOCALAPPDATA\n"));
  assert.ok(script.includes(`$local ${rooted}`));
  assert.ok(script.includes("'Programs','Laundry Desk Runtime V2',$q.manifest_sha256"));
});
