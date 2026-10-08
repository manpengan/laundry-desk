import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { stageRuntimeMaintenance } from "./stage-runtime-maintenance.mjs";
test("packaging pins a matching release in bundled code and refuses rebinding or tampering", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "maintenance-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/maintenance"), { recursive: true });
  const entryDirectory = join(root, "entry");
  await mkdir(entryDirectory);
  const source = "1".repeat(40),
    entry = "verified entry fixture";
  const evidence = {
    schema: "laundry.windows.runtime-operator-entry",
    version: 1,
    assurance: "development_only",
    source_git_sha: source,
    manifest_sha256: "a".repeat(64),
    entry_sha256: createHash("sha256").update(entry).digest("hex"),
  };
  await writeFile(join(entryDirectory, "runtime-entry.ps1"), entry);
  await writeFile(join(entryDirectory, "release-evidence.json"), JSON.stringify(evidence));
  const options = { packageRoot: root, entryDirectory, expectedGitSha: source };
  assert.equal((await stageRuntimeMaintenance(options)).enabled, true);
  const text = await readFile(join(root, "dist/maintenance/runtime-binding.js"), "utf8");
  assert.match(text, /LaundryCounterMaintenanceTrust/u);
  assert.ok(text.includes(evidence.entry_sha256));
  await assert.rejects(
    stageRuntimeMaintenance({ ...options, expectedGitSha: "2".repeat(40) }),
    /RELEASE_INVALID/u,
  );
  await writeFile(join(entryDirectory, "runtime-entry.ps1"), "changed");
  await assert.rejects(stageRuntimeMaintenance(options), /ENTRY_CHANGED/u);
  assert.equal((await stageRuntimeMaintenance({ packageRoot: root })).enabled, false);
  assert.match(
    await readFile(join(root, "dist/maintenance/runtime-binding.js"), "utf8"),
    /= null/u,
  );
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
