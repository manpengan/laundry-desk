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
