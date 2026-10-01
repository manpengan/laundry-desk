import assert from "node:assert/strict";
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { digest } from "./companion-contract.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";
import { packageRuntimeEntry } from "./package-runtime-entry.mjs";
import {
  bootstrapBinding,
  COMMAND_NAME,
  ENTRY_ACTIONS,
  ENTRY_NAME,
  requireEntryArguments,
  renderEntry,
} from "./runtime-entry-contract.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";

test("operator package keeps a separately bound entry outside the unchanged fixed payload", async (t) => {
  const fixture = await runtimeEntryFixture(t);
  const report = await packageRuntimeEntry(fixture);
  assert.equal(report.assurance, "development_only");
  const entryBytes = await readFile(join(report.output, ENTRY_NAME));
  assert.deepEqual([...entryBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(digest(entryBytes), report.entry_sha256);
  const entry = entryBytes.toString("utf8");
  assert.match(entry, new RegExp(`\\$BoundSource = '${fixture.sourceSha}'`, "u"));
  assert.match(entry, new RegExp(`\\$BoundManifest = '${fixture.manifestSha}'`, "u"));
  assert.equal(entry.includes("@@"), false);
  assert.match(entry, /Join-Path \$EntryRoot 'payload'/u);
  assert.doesNotMatch(
    entry.split("$ErrorActionPreference")[0],
    /\$Payload|\$ManifestDigest|\$SourceSha/u,
  );
  assert.deepEqual(
    await inspectCompanion(join(report.output, "payload"), fixture.manifestSha),
    fixture.manifest,
  );
  const evidence = JSON.parse(await readFile(join(report.output, "release-evidence.json"), "utf8"));
  assert.equal(evidence.entry_sha256, report.entry_sha256);
  for (const file of evidence.operator_files)
    assert.equal(digest(await readFile(join(report.output, file.path))), file.sha256);
  const command = await readFile(join(report.output, COMMAND_NAME), "utf8");
  assert.match(command, /-NoProfile -STA -ExecutionPolicy Bypass/u);
  assert.doesNotMatch(command, /%\*|powershell\.exe"?\s+-Command/iu);
});

test("the generated trust boundary verifies every bootstrap script and operator helper before dot-sourcing", async (t) => {
  const fixture = await runtimeEntryFixture(t);
  const files = bootstrapBinding(fixture.manifest, fixture.manifestSha, fixture.sourceSha);
  assert.equal(
    files.length,
    fixture.manifest.files.filter(
      ({ path }) => path.startsWith("scripts/") || path === "node/node.exe",
    ).length,
  );
  const report = await packageRuntimeEntry(fixture);
  const entry = await readFile(join(report.output, ENTRY_NAME), "utf8");
  assert.ok(
    entry.indexOf("foreach ($entry in $BoundOperator)") <
      entry.indexOf(". (Join-Path $EntryRoot 'runtime-entry-install.ps1')"),
  );
  assert.ok(
    entry.indexOf("foreach ($entry in $BoundOperator)") <
      entry.indexOf(". (Join-Path $EntryRoot 'runtime-entry-shortcut.ps1')"),
  );
  assert.match(entry, /FILE_SHARE_READ/u);
  assert.match(entry, /ReparsePoint/u);
  assert.match(entry, /info\.Links != 1/u);
  assert.match(entry, /foreach \(\$file in \$held\)/u);
  assert.match(entry, /CreateFileW\(path, 0x80000000, 1, IntPtr\.Zero, 3, 0x00200000/u);
  assert.match(entry, /ReleaseDirectories\(\)/u);
  assert.match(entry, /if \(\$policy -ceq 'Bypass'\)/u);
});

test("packaging refuses source rebinding, payload tampering, untrusted links and destination overlay", async (t) => {
  const fixture = await runtimeEntryFixture(t);
  await assert.rejects(
    packageRuntimeEntry({ ...fixture, sourceSha: "c".repeat(40) }),
    /BINDING_INVALID/u,
  );
  await assert.rejects(
    packageRuntimeEntry({ ...fixture, manifestSha: "c".repeat(64) }),
    /MANIFEST_DIGEST_INVALID/u,
  );
  await mkdir(fixture.output);
  const sentinel = join(fixture.output, "sentinel.txt");
  await writeFile(sentinel, "existing user file");
  await assert.rejects(packageRuntimeEntry(fixture), /OUTPUT_EXISTS/u);
  assert.equal(await readFile(sentinel, "utf8"), "existing user file");
  await assert.rejects(
    packageRuntimeEntry({ ...fixture, output: join(fixture.payload, "nested") }),
    /OUTPUT_INVALID/u,
  );
  await link(
    join(fixture.payload, "scripts/lifecycle-launch.ps1"),
    join(fixture.root, "alias.ps1"),
  );
  await assert.rejects(
    packageRuntimeEntry({ ...fixture, output: join(fixture.root, "other") }),
    /FILE_INVALID/u,
  );
});

test("operator action contract requires a selected backup and manual complete restore digest", () => {
  for (const action of ENTRY_ACTIONS.filter(
    (name) => !["backup-verify", "restore"].includes(name),
  )) {
    assert.deepEqual(requireEntryArguments(action), { action });
    assert.throws(() => requireEntryArguments(action, `b_${"a".repeat(32)}`), /ARGS_INVALID/u);
  }
  const id = `b_${"a".repeat(32)}`,
    confirmation = "b".repeat(64);
  assert.deepEqual(requireEntryArguments("restore", id, confirmation), {
    action: "restore",
    backupId: id,
    confirmation,
  });
  assert.deepEqual(requireEntryArguments("backup-verify", id), {
    action: "backup-verify",
    backupId: id,
  });
  for (const [action, selected, confirmed] of [
    ["restore", id],
    ["restore", id, ""],
    ["restore", id, confirmation.slice(1)],
    ["restore", "../backup", confirmation],
    ["backup-verify", id, confirmation],
    ["unknown"],
  ])
    assert.throws(() => requireEntryArguments(action, selected, confirmed), /ARGS_INVALID/u);
});

test("template rendering rejects missing, repeated and unresolved compile-time bindings", () => {
  assert.equal(renderEntry("@@VALUE@@", { VALUE: "fixed" }), "fixed");
  for (const template of ["absent", "@@VALUE@@@@VALUE@@", "@@VALUE@@@@OTHER@@"])
    assert.throws(() => renderEntry(template, { VALUE: "fixed" }), /TEMPLATE_INVALID/u);
});
