import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
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
  if (process.platform !== "win32") {
    assert.notEqual(await hashAppTree(modeRoot), baseline);
  }

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
  assert.match(builderText, /^npmRebuild:\s+false$/mu);
  assert.match(builderText, /^electronDist:\s+\.\.\/\.\.\/node_modules\/electron\/dist$/mu);
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
  assert.ok(
    includedFiles.includes("dist/desktop/request-builder.js"),
    "desktop request builder must ship with its importing transport",
  );
  assert.ok(
    includedFiles.includes("dist/desktop/electron-photo-request.js"),
    "desktop photo request must ship with its importing adapter",
  );
  assert.ok(
    includedFiles.includes("dist/desktop/edge-authority-transport.js"),
    "fresh Edge authority exchange must ship with its importing transport",
  );
  assert.ok(
    includedFiles.includes("dist/desktop/edge-http.js"),
    "device-signed Edge HTTP helper must ship with its importing transport",
  );
  assert.ok(
    includedFiles.includes("dist/desktop/http-transport-support.js"),
    "desktop transport support must ship with its importing transport",
  );
  assert.ok(
    includedFiles.includes("dist/pairing/device-keys.js"),
    "Primary Lease signature decoding must ship with its importing verifier",
  );
  assert.ok(
    includedFiles.includes("dist/pairing/authority-trust.js"),
    "persistent authority signer trust must ship with its importing runtime",
  );
  assert.ok(
    includedFiles.includes("dist/pairing/safe-storage-device-keys.js"),
    "Keychain-backed device key store must ship with its importing shell",
  );
  for (const stage3Module of [
    "dist/desktop/print-http-transport.js",
    "dist/desktop/printer-operation.js",
    "dist/print/continuity.js",
    "dist/print/configured-runtime.js",
    "dist/print/cups-queue.js",
    "dist/print/dispatch-controller.js",
    "dist/print/dispatch-ledger-state.js",
    "dist/print/dispatch-ledger.js",
    "dist/print/dispatch-verifier.js",
    "dist/print/durable-json-file.js",
    "dist/print/mac-printer-pilot.js",
    "dist/print/main-runtime.js",
    "dist/print/printer-config.js",
    "dist/print/printer-smoke.js",
    "dist/print/raw-print-port.js",
    "dist/print/runtime.js",
    "dist/print/signed-executor.js",
    "dist/print/snapshot-render.js",
    "dist/print/usb-port.js",
    "dist/print/windows-printer-pilot.js",
    "dist/pairing/sign-receipt.js",
    "dist/pairing/verify-ticket.js",
  ]) {
    assert.ok(
      includedFiles.includes(stage3Module),
      `signed print runtime missing: ${stage3Module}`,
    );
  }
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
  assert.doesNotMatch(builderText, /dmg|notari|publish/iu);
  assert.match(builderText, /^forceCodeSigning:\s+false$/mu);
  assert.match(builderText, /^win:\n/mu);
  assert.match(builderText, /^\s+requestedExecutionLevel:\s+asInvoker$/mu);
  assert.match(builderText, /^\s+signExecutable:\s+false$/mu);
  assert.match(builderText, /^\s+-\s+target:\s+nsis$/mu);
  assert.match(builderText, /^\s+-\s+x64$/mu);
  assert.match(builderText, /^\s+-\s+from:\s+resources\/windows-helper$/mu);
  assert.match(builderText, /^\s+to:\s+windows-helper$/mu);
  assert.match(builderText, /^nsis:\n/mu);
  assert.match(builderText, /^\s+oneClick:\s+false$/mu);
  assert.match(builderText, /^\s+perMachine:\s+false$/mu);
  assert.match(builderText, /^\s+allowElevation:\s+false$/mu);
  assert.match(builderText, /^\s+allowToChangeInstallationDirectory:\s+true$/mu);
  assert.match(builderText, /^\s+packElevateHelper:\s+false$/mu);
  assert.match(builderText, /^\s+deleteAppDataOnUninstall:\s+false$/mu);
  assert.match(
    builderText,
    /^\s+artifactName:\s+"laundry-desk-v2-\$\{version\}-windows-x64-development-only\.\$\{ext\}"$/mu,
  );
  assert.match(filesBlock, /^\s+-\s+"!\*\*\/node_modules\/@laundry\/platform-fs\/native\/\*\*"$/mu);

  assert.equal(packageJson.main, "./dist/main.js");
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "@laundry/contracts",
    "@laundry/platform-fs",
    "iconv-lite",
    "zod",
  ]);
  assert.equal(packageJson.scripts["preload:bundle"], "node scripts/build-preload.mjs");
  assert.equal(packageJson.scripts["hash:app"], "node scripts/hash-app.mjs");
  const packageMac = packageJson.scripts["package:mac"];
  assert.equal(typeof packageMac, "string");
  const platformBuildIndex = packageMac.indexOf("pnpm --filter @laundry/platform-fs build");
  const graphBuildIndex = packageMac.indexOf(
    "pnpm exec turbo run build --filter=@laundry/edge-agent",
  );
  const preloadIndex = packageMac.indexOf("pnpm run preload:bundle");
  const builderIndex = packageMac.indexOf("electron-builder");
  assert.ok(
    platformBuildIndex >= 0 &&
      graphBuildIndex > platformBuildIndex &&
      preloadIndex > graphBuildIndex &&
      builderIndex > preloadIndex,
  );
  assert.deepEqual(turboJson.tasks["@laundry/edge-agent#build"].outputs, [
    "dist/**",
    "resources/spa/**",
  ]);
  assert.match(packageMac, /electron-builder\.yml/u);
  assert.doesNotMatch(packageMac, /dmg|notari|publish|windows|nsis|root|src\//iu);

  assert.equal(packageJson.scripts["helper:stage:win"], "node scripts/stage-windows-helper.mjs");
  const packageWin = packageJson.scripts["package:win"];
  assert.equal(typeof packageWin, "string");
  const winPlatformBuildIndex = packageWin.indexOf("pnpm --filter @laundry/platform-fs build");
  const winGraphBuildIndex = packageWin.indexOf(
    "pnpm exec turbo run build --filter=@laundry/edge-agent",
  );
  const helperStageIndex = packageWin.indexOf("pnpm run helper:stage:win");
  const winPreloadIndex = packageWin.indexOf("pnpm run preload:bundle");
  const winBuilderIndex = packageWin.indexOf("electron-builder");
  assert.ok(
    winPlatformBuildIndex >= 0 &&
      winGraphBuildIndex > winPlatformBuildIndex &&
      helperStageIndex > winGraphBuildIndex &&
      winPreloadIndex > helperStageIndex &&
      winBuilderIndex > winPreloadIndex,
  );
  assert.match(packageWin, /--win nsis --x64/u);
  assert.doesNotMatch(packageWin, /hongfa|publish|root|src\//iu);
});

test("packaged runtime whitelist is closed under relative JavaScript imports", async () => {
  const builderText = await readFile(join(packageRoot, "electron-builder.yml"), "utf8");
  const filesBlock = /^files:\n(?<body>(?:  - .+\n)+)/mu.exec(builderText)?.groups?.body;
  assert.ok(filesBlock, "electron-builder files whitelist must exist");
  const includedFiles = new Set(
    filesBlock
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\s*-\s+/u, "").replaceAll('"', ""))
      .filter((entry) => !entry.startsWith("!") && entry.endsWith(".js")),
  );
  const missing = [];
  for (const file of includedFiles) {
    const source = await readFile(join(packageRoot, file), "utf8");
    const runtimeImports = Array.from(
      source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+\.js)["']/gu),
      (match) => match[1],
    );
    for (const runtimeImport of runtimeImports) {
      const resolved = posix.normalize(posix.join(posix.dirname(file), runtimeImport));
      if (!includedFiles.has(resolved)) missing.push(`${file} -> ${resolved}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
});

test("mac acceptance does not persist credentials or inherit arbitrary host secrets", async () => {
  const config = await readFile(join(packageRoot, "playwright.electron.config.ts"), "utf8");
  const smoke = await readFile(join(packageRoot, "e2e", "local-mac.spec.ts"), "utf8");
  const main = await readFile(join(packageRoot, "src", "main.ts"), "utf8");
  const localBuilder = await readFile(join(packageRoot, "electron-builder.yml"), "utf8");
  const releaseBuilder = await readFile(join(packageRoot, "electron-builder.release.yml"), "utf8");

  assert.match(config, /trace:\s*"off"/u);
  assert.match(config, /screenshot:\s*"off"/u);
  assert.doesNotMatch(config, /retain-on-failure|only-on-failure/u);
  assert.match(smoke, /PASSTHROUGH_ENV_KEYS/u);
  assert.doesNotMatch(smoke, /Object\.entries\(process\.env\)/u);
  assert.match(smoke, /detached:\s*true/u);
  assert.match(smoke, /signalProcessGroup\(processId,\s*"SIGTERM"\)/u);
  assert.match(smoke, /signalProcessGroup\(processId,\s*"SIGKILL"\)/u);
  assert.match(smoke, /await waitForProcessGroupExit\(processId\)/u);
  assert.match(smoke, /args:\s*\[[^\]]*"--use-mock-keychain"\]/u);
  assert.doesNotMatch(`${main}\n${localBuilder}\n${releaseBuilder}`, /--use-mock-keychain/u);
});

test("Windows package evidence uses Electron, DPAPI and a credential-free fixed artifact path", async () => {
  const config = await readFile(
    join(packageRoot, "playwright.electron.windows-package.config.ts"),
    "utf8",
  );
  const smoke = await readFile(join(packageRoot, "e2e", "package-win.spec.ts"), "utf8");
  const inspector = await readFile(
    join(packageRoot, "scripts", "inspect-packaged-win.mjs"),
    "utf8",
  );
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

  assert.match(config, /trace:\s*"off"/u);
  assert.match(config, /screenshot:\s*"off"/u);
  assert.match(config, /video:\s*"off"/u);
  assert.match(smoke, /_electron as electron/u);
  assert.match(smoke, /safeStorage\.isEncryptionAvailable\(\)/u);
  assert.match(smoke, /process\.platform\)\.toBe\("win32"\)/u);
  assert.match(smoke, /test-results["',\s\n]+windows-package["',\s\n]+desktop-smoke\.png/u);
  assert.match(smoke, /printer-config\.json/u);
  assert.doesNotMatch(smoke, /Object\.entries\(process\.env\)|--use-mock-keychain/u);
  assert.match(inspector, /Get-AuthenticodeSignature/u);
  assert.match(inspector, /0x8664/u);
  assert.match(inspector, /development-only/u);
  assert.equal(packageJson.scripts["package:inspect:win"], "node scripts/inspect-packaged-win.mjs");
  assert.equal(
    packageJson.scripts["package:smoke:win"],
    "pnpm exec playwright test -c playwright.electron.windows-package.config.ts",
  );
});

test("packaged commissioning acceptance is isolated from SQL fixtures and artifacts", async () => {
  const config = await readFile(
    join(packageRoot, "playwright.electron.commissioning.config.ts"),
    "utf8",
  );
  const spec = await readFile(join(packageRoot, "e2e", "commissioning-mac.spec.ts"), "utf8");

  assert.match(config, /trace:\s*"off"/u);
  assert.match(config, /screenshot:\s*"off"/u);
  assert.match(config, /video:\s*"off"/u);
  assert.match(spec, /PASSTHROUGH_ENV_KEYS/u);
  assert.match(spec, /LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD/u);
  assert.match(spec, /toHaveCount\(2/u);
  assert.doesNotMatch(spec, /\b(?:INSERT|UPDATE|DELETE|SELECT)\b|from\s+"pg"|createRequire/u);
  assert.doesNotMatch(spec, /Object\.entries\(process\.env\)/u);
});

test("release packaging is fail-closed, notarized, and keeps the local whitelist exact", async () => {
  const localBuilder = await readFile(join(packageRoot, "electron-builder.yml"), "utf8");
  const releaseBuilder = await readFile(join(packageRoot, "electron-builder.release.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const localFiles = /^files:\n(?<body>(?:  - .+\n)+)/mu.exec(localBuilder)?.groups?.body;
  const releaseFiles = /^files:\n(?<body>(?:  - .+\n)+)/mu.exec(releaseBuilder)?.groups?.body;

  assert.equal(releaseFiles, localFiles);
  for (const modulePath of [
    "dist/offline/grant-sequence-store.js",
    "dist/offline/offline-command-policy.js",
  ]) {
    assert.match(localFiles ?? "", new RegExp(`^  - ${modulePath}$`, "mu"));
    assert.match(releaseFiles ?? "", new RegExp(`^  - ${modulePath}$`, "mu"));
  }
  assert.match(releaseBuilder, /^forceCodeSigning:\s+true$/mu);
  assert.match(releaseBuilder, /^\s+hardenedRuntime:\s+true$/mu);
  assert.match(releaseBuilder, /^\s+notarize:\s+true$/mu);
  assert.match(releaseBuilder, /^\s+entitlements:\s+build\/entitlements\.mac\.plist$/mu);
  assert.match(releaseBuilder, /^\s+entitlementsInherit:\s+build\/entitlements\.mac\.plist$/mu);
  assert.match(releaseBuilder, /^\s+-\s+target:\s+dmg$/mu);
  assert.match(releaseBuilder, /^\s+-\s+target:\s+zip$/mu);
  assert.equal((releaseBuilder.match(/^\s+-\s+universal$/gmu) ?? []).length, 2);
  assert.match(releaseBuilder, /^\s+output:\s+\$\{env\.LAUNDRY_RELEASE_OUTPUT_DIRECTORY\}$/mu);
  assert.match(
    releaseBuilder,
    /^\s+artifactName:\s+"\$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}"$/mu,
  );
  assert.match(releaseBuilder, /^\s+to:\s+update\/update-public-key\.pem$/mu);
  assert.match(releaseBuilder, /^\s+to:\s+update\/update-config\.json$/mu);
  assert.match(releaseBuilder, /\$\{env\.LAUNDRY_RELEASE_UPDATE_PUBLIC_KEY_FILE\}/u);
  assert.match(releaseBuilder, /\$\{env\.LAUNDRY_RELEASE_UPDATE_CONFIG_FILE\}/u);
  assert.match(localBuilder, /resources\/update\/update-config\.development\.json/u);
  assert.doesNotMatch(releaseBuilder, /^\s+identity:\s+null$/mu);
  assert.equal(packageJson.scripts["release:mac"], "node scripts/release-mac.mjs");
});
