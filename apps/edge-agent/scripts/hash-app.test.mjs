import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashAppTree } from "./hash-app.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(packageRoot, "..", "..");
const hashAppScript = join(packageRoot, "scripts", "hash-app.mjs");
const execFileAsync = promisify(execFile);

async function createAppFixture(parent, name = "laundry-desk V2.app") {
  const appRoot = join(parent, name);
  const executable = join(appRoot, "Contents", "MacOS", "laundry-desk V2");
  const frameworkRoot = join(appRoot, "Contents", "Frameworks", "Demo.framework", "Versions");
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(join(frameworkRoot, "A"), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(frameworkRoot, "A", "Demo"), "framework-bytes\n", { mode: 0o644 });
  await symlink("A", join(frameworkRoot, "Current"));
  return appRoot;
}

test("identical app trees have one deterministic path-independent hash", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-hash-app-"));
  t.after(async () => {
    await rm(temporary, { recursive: true });
  });
  const first = await createAppFixture(join(temporary, "first"));
  const second = await createAppFixture(join(temporary, "second"));

  const firstHash = await hashAppTree(first);
  const secondHash = await hashAppTree(second);

  assert.match(firstHash, /^[0-9a-f]{64}$/u);
  assert.equal(firstHash, secondHash);
});

test("file bytes, relative path, mode, and symlink target are hash inputs", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-hash-app-inputs-"));
  t.after(async () => {
    await rm(temporary, { recursive: true });
  });
  const baselineRoot = await createAppFixture(join(temporary, "baseline"));
  const baseline = await hashAppTree(baselineRoot);

  const bytesRoot = await createAppFixture(join(temporary, "bytes"));
  await writeFile(join(bytesRoot, "Contents", "MacOS", "laundry-desk V2"), "#!/bin/sh\nexit 7\n", {
    mode: 0o755,
  });
  assert.notEqual(await hashAppTree(bytesRoot), baseline);

  const pathRoot = await createAppFixture(join(temporary, "path"));
  await writeFile(join(pathRoot, "Contents", "extra.txt"), "framework-bytes\n");
  assert.notEqual(await hashAppTree(pathRoot), baseline);

  const modeRoot = await createAppFixture(join(temporary, "mode"));
  await chmod(join(modeRoot, "Contents", "MacOS", "laundry-desk V2"), 0o700);
  assert.notEqual(await hashAppTree(modeRoot), baseline);

  const linkRoot = await createAppFixture(join(temporary, "link"));
  await mkdir(join(linkRoot, "Contents", "Frameworks", "Demo.framework", "Versions", "B"), {
    recursive: true,
  });
  const current = join(linkRoot, "Contents", "Frameworks", "Demo.framework", "Versions", "Current");
  await unlink(current);
  await symlink("B", current);
  assert.notEqual(await hashAppTree(linkRoot), baseline);
});

test("entry type is a hash input", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-hash-app-type-"));
  t.after(async () => {
    await rm(temporary, { recursive: true });
  });
  const fileRoot = await createAppFixture(join(temporary, "file"));
  await writeFile(join(fileRoot, "Contents", "kind"), "");
  const directoryRoot = await createAppFixture(join(temporary, "directory"));
  await mkdir(join(directoryRoot, "Contents", "kind"));

  assert.notEqual(await hashAppTree(fileRoot), await hashAppTree(directoryRoot));
});

test("hashAppTree rejects non-app roots and escaping symlinks", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-hash-app-reject-"));
  t.after(async () => {
    await rm(temporary, { recursive: true });
  });
  const appRoot = await createAppFixture(temporary);

  await assert.rejects(() => hashAppTree("relative.app"), /absolute macOS app path/u);
  await assert.rejects(() => hashAppTree(temporary), /must end in \.app/u);

  const escaping = join(appRoot, "Contents", "escape");
  await symlink("../../../outside", escaping);
  await assert.rejects(() => hashAppTree(appRoot), /symbolic link escapes the app tree/u);
});

test("hashAppTree rejects absolute symlinks even when their target is inside the app", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-hash-app-absolute-link-"));
  t.after(async () => {
    await rm(temporary, { recursive: true });
  });
  const appRoot = await createAppFixture(temporary);
  const target = join(appRoot, "Contents", "MacOS", "laundry-desk V2");
  await symlink(target, join(appRoot, "Contents", "absolute-link"));

  await assert.rejects(() => hashAppTree(appRoot), /symbolic link must be relative/u);
});

test("hash-app CLI accepts an absolute app path and prints only its digest", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "laundry-hash-app-cli-"));
  t.after(async () => {
    await rm(temporary, { recursive: true });
  });
  const appRoot = await createAppFixture(temporary);

  const { stdout, stderr } = await execFileAsync(process.execPath, [hashAppScript, appRoot]);

  assert.match(stdout, /^[0-9a-f]{64}\n$/u);
  assert.equal(stderr, "");
  assert.equal(stdout.trim(), await hashAppTree(appRoot));
});

test("V2 packaging is generic, unsigned, whitelisted, and independent of frozen v1", async () => {
  const builderText = await readFile(join(packageRoot, "electron-builder.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const turboJson = JSON.parse(await readFile(join(workspaceRoot, "turbo.json"), "utf8"));
  const filesBlock = /^files:\n(?<body>(?:  - .+\n)+)/mu.exec(builderText)?.groups?.body;

  assert.match(builderText, /^appId:\s+com\.laundry-desk\.v2$/mu);
  assert.match(builderText, /^productName:\s+laundry-desk V2$/mu);
  assert.match(builderText, /^\s+output:\s+release$/mu);
  assert.match(builderText, /^asar:\s+true$/mu);
  assert.match(builderText, /^afterPack:\s+\.\/scripts\/prune-packaged-spa\.mjs$/mu);
  assert.match(builderText, /^extraResources:\n\s+-\s+from:\s+resources\/spa$/mu);
  assert.match(builderText, /^\s+to:\s+spa$/mu);
  assert.match(builderText, /^\s+-\s+dist\/preload\.cjs$/mu);
  assert.match(builderText, /^\s+-\s+package\.json$/mu);
  assert.match(builderText, /^\s+identity:\s+null$/mu);
  assert.match(builderText, /^\s+target:\s+dir$/mu);
  assert.ok(filesBlock, "electron-builder files whitelist must exist");
  const includedFiles = filesBlock
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s*-\s+/u, "").replaceAll('"', ""))
    .filter((entry) => !entry.startsWith("!"));
  assert.doesNotMatch(
    includedFiles.join("\n"),
    /\*|tests?|spec|\.d\.ts|\.map|src\/|\.env|credentials?|secrets?|logs?/iu,
  );
  for (const exclusion of [
    "!**/*.test.*",
    "!**/*.spec.*",
    "!**/*.d.*",
    "!**/*.map",
    "!**/*.ts",
    "!**/*.tsx",
    "!**/*.mts",
    "!**/*.cts",
    "!**/src/**",
    "!**/test/**",
    "!**/tests/**",
    "!**/.turbo/**",
    "!**/*.log",
    "!**/.env*",
    "!**/*credential*",
    "!**/node_modules/**/*.md",
    "!**/node_modules/**/.eslintrc*",
    "!**/node_modules/**/tsconfig*.json",
    "!**/node_modules/**/docs/**",
    "!**/node_modules/**/tests.js",
    "!**/node_modules/@laundry/contracts/openapi/**",
  ]) {
    assert.ok(filesBlock.includes(exclusion), `missing package exclusion: ${exclusion}`);
  }
  assert.doesNotMatch(builderText, /hongfa|\.\.\/\.\.\/src/iu);
  assert.doesNotMatch(builderText, /dmg|notari|publish|windows|nsis/iu);

  assert.equal(packageJson.main, "./dist/main.js");
  assert.equal(packageJson.scripts["preload:bundle"], "node scripts/build-preload.mjs");
  assert.equal(packageJson.scripts["hash:app"], "node scripts/hash-app.mjs");
  const packageMac = packageJson.scripts["package:mac"];
  assert.equal(typeof packageMac, "string");
  const graphBuildIndex = packageMac.indexOf(
    "pnpm exec turbo run build --filter=@laundry/edge-agent",
  );
  const preloadIndex = packageMac.indexOf("pnpm run preload:bundle");
  const builderIndex = packageMac.indexOf("electron-builder");
  assert.ok(graphBuildIndex >= 0 && preloadIndex > graphBuildIndex && builderIndex > preloadIndex);
  assert.deepEqual(turboJson.tasks["@laundry/edge-agent#build"].outputs, [
    "dist/**",
    "resources/spa/**",
  ]);
  assert.match(packageMac, /electron-builder\.yml/u);
  assert.doesNotMatch(packageMac, /dmg|notari|publish|windows|nsis|root|src\//iu);
});

test("mac acceptance does not persist credentials or inherit arbitrary host secrets", async () => {
  const config = await readFile(join(packageRoot, "playwright.electron.config.ts"), "utf8");
  const smoke = await readFile(join(packageRoot, "e2e", "local-mac.spec.ts"), "utf8");

  assert.match(config, /trace:\s*"off"/u);
  assert.match(config, /screenshot:\s*"off"/u);
  assert.doesNotMatch(config, /retain-on-failure|only-on-failure/u);
  assert.match(smoke, /PASSTHROUGH_ENV_KEYS/u);
  assert.doesNotMatch(smoke, /Object\.entries\(process\.env\)/u);
  assert.match(smoke, /detached:\s*true/u);
  assert.match(smoke, /signalProcessGroup\(processId,\s*"SIGTERM"\)/u);
  assert.match(smoke, /signalProcessGroup\(processId,\s*"SIGKILL"\)/u);
  assert.match(smoke, /await waitForProcessGroupExit\(processId\)/u);
});
