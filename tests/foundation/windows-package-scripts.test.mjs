import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const packagePaths = Object.freeze([
  "apps/edge-agent/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/ui/package.json",
]);

test("compiled package tests use a Windows-compatible Node glob", async () => {
  for (const packagePath of packagePaths) {
    const source = await readFile(join(repositoryRoot, packagePath), "utf8");
    const packageJson = JSON.parse(source);
    const testScript = packageJson.scripts?.test;

    assert.equal(typeof testScript, "string", `${packagePath} must define scripts.test`);
    assert.doesNotMatch(testScript, /\$\(/u, `${packagePath} must not use shell substitution`);
    assert.match(
      testScript,
      /node --test(?: --test-concurrency=1)? "dist\/\*\*\/\*\.test\.js"/u,
      `${packagePath} must preserve the glob for Node on POSIX and Windows shells`,
    );
  }
});

test("the Windows helper narrows ACLs without requiring ownership elevation", async () => {
  const source = await readFile(
    join(repositoryRoot, "packages/platform-fs/native/windows/LaundryWindowsHelper.cs"),
    "utf8",
  );

  assert.match(source, /if \(owner\.Equals\(current\)\) return;/u);
  assert.match(source, /WellKnownSidType\.BuiltinAdministratorsSid/u);
  assert.match(source, /principal\.IsInRole\(WindowsBuiltInRole\.Administrator\)/u);
  assert.match(source, /security\.SetOwner\(current\);/u);
  assert.doesNotMatch(source, /security\.SetOwner\(owner\);/u);
  assert.match(source, /NormalizeCurrentOwner\(security, owner\);/u);
  assert.match(source, /RemoveAccessRuleSpecific\(rule\);/u);
  assert.match(source, /File\.SetAccessControl\(path, PrivateSecurity\(path, current\)\);/u);
  assert.match(
    source,
    /Directory\.SetAccessControl\(path, PrivateDirectorySecurity\(path, current\)\);/u,
  );
});

test("development-only Windows packaging is bound to one explicit clean source commit", async () => {
  const [builder, stager, inspector] = await Promise.all([
    readFile(join(repositoryRoot, "apps/edge-agent/electron-builder.yml"), "utf8"),
    readFile(join(repositoryRoot, "apps/edge-agent/scripts/stage-windows-helper.mjs"), "utf8"),
    readFile(join(repositoryRoot, "apps/edge-agent/scripts/inspect-packaged-win.mjs"), "utf8"),
  ]);

  assert.match(
    builder,
    /from: resources\/windows-helper\/windows-build-provenance\.json[\s\S]+to: build-provenance\/windows-source\.json/u,
  );
  assert.match(stager, /LAUNDRY_WINDOWS_BUILD_GIT_SHA/u);
  assert.match(stager, /--porcelain=v1/u);
  assert.match(stager, /--untracked-files=all/u);
  assert.match(stager, /WINDOWS_BUILD_SOURCE_NOT_CLEAN/u);
  assert.match(stager, /WINDOWS_BUILD_SOURCE_SHA_MISMATCH/u);
  assert.match(inspector, /parseWindowsBuildProvenance/u);
  assert.match(inspector, /source_git_sha/u);
  assert.match(inspector, /source_tree/u);
  assert.doesNotMatch(`${stager}\n${inspector}`, /origin\/main|hk-vps|pilot/iu);
});
