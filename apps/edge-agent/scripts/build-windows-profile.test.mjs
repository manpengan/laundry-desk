import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  requireWindowsBuildProfile,
  windowsBuilderConfiguration,
} from "./build-windows-profile.mjs";
import { getWindowsProfileBuildSettings, loadWindowsProfile } from "./windows-profile.mjs";

test("profile selection is restricted before it becomes a build path", () => {
  assert.equal(requireWindowsBuildProfile(), "generic");
  assert.equal(requireWindowsBuildProfile("hongfa"), "hongfa");
  for (const value of ["../generic", "production", "", null]) {
    assert.throws(() => requireWindowsBuildProfile(value), /WINDOWS_PROFILE_ID_INVALID/u);
  }
});

test("effective electron-builder config inherits each trusted resource once and keeps safety settings", async () => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { getConfig } = builderRequire("app-builder-lib/out/util/config/config.js");
  const projectDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
  for (const profileId of ["generic", "hongfa"]) {
    const { profile } = await loadWindowsProfile({ profileId });
    const settings = getWindowsProfileBuildSettings(profile);
    const config = await getConfig(
      projectDir,
      undefined,
      windowsBuilderConfiguration({
        settings,
        targetRoot: "/fixture/windows-profile",
      }),
    );
    assert.deepEqual(
      config.extraResources.map(({ to }) => to),
      ["spa", "update/update-config.json"],
    );
    assert.deepEqual(
      config.win.extraResources.map(({ to }) => to),
      [
        "windows-helper",
        "build-provenance/windows-source.json",
        "distribution-profile",
        "windows-runtime-guide.txt",
      ],
    );
    assert.equal(config.appId, settings.appId);
    assert.equal(config.productName, settings.displayName);
    assert.equal(config.win.requestedExecutionLevel, "asInvoker");
    assert.equal(config.win.signExecutable, false);
    assert.equal(config.nsis.allowElevation, false);
    assert.equal(config.nsis.packElevateHelper, false);
    assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  }
});

test("both brands keep helper provenance, runtime guidance and separate release directories", async () => {
  for (const profileId of ["generic", "hongfa"]) {
    const { profile } = await loadWindowsProfile({ profileId });
    const settings = getWindowsProfileBuildSettings(profile);
    const targetRoot = "/fixture/windows-profile";
    const config = windowsBuilderConfiguration({ settings, targetRoot });
    assert.equal(config.extends, undefined);
    assert.equal(config.appId, profile.app_id);
    assert.equal(config.productName, profile.display_name);
    assert.equal(config.directories.output, "release/" + profileId);
    assert.equal(config.nsis.artifactName, settings.installerFileName);
    assert.equal(config.nsis.include, "build/windows-runtime-guide.nsh");
    assert.deepEqual(
      config.win.extraResources.map(({ to }) => to),
      ["distribution-profile", "windows-runtime-guide.txt"],
    );
    assert.deepEqual(config.win.extraResources[0], {
      from: targetRoot,
      to: "distribution-profile",
      filter: ["profile.json", "binding.json"],
    });
    assert.equal(profile.service_origin, "http://127.0.0.1:8787");
  }
});

test("a failed CLI build retains exit status one after builder shutdown callbacks", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ld-builder-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts"),
    profiles = join(root, "resources/windows-profiles"),
    builder = join(root, "node_modules/electron-builder");
  await Promise.all([scripts, profiles, builder].map((path) => mkdir(path, { recursive: true })));
  await Promise.all(
    ["build-windows-profile.mjs", "windows-profile.mjs", "windows-package-version.mjs"].map(
      (name) => copyFile(new URL(name, import.meta.url), join(scripts, name)),
    ),
  );
  await copyFile(new URL("../package.json", import.meta.url), join(root, "package.json"));
  await copyFile(
    new URL("../resources/windows-profiles/generic.json", import.meta.url),
    join(profiles, "generic.json"),
  );
  await writeFile(
    join(builder, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  await writeFile(
    join(builder, "index.mjs"),
    `export const Platform = { WINDOWS: { createTarget() { return {}; } } };
export const Arch = { x64: 1 };
export async function build() {
  process.on("exit", () => { process.exitCode = 0; });
  throw new Error("synthetic-builder-private-details-must-not-leak");
}
`,
  );
  const preload = join(root, "native-platform.mjs");
  // Load native path semantics before the test-only platform override.
  await writeFile(
    preload,
    'import "node:path"; Object.defineProperty(process, "platform", { value: "win32" });\n',
  );
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, join(scripts, "build-windows-profile.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE: "generic",
        LAUNDRY_WINDOWS_BUILD_GIT_SHA: "a".repeat(40),
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), "");
  assert.equal(result.stderr.trim(), "WINDOWS_PROFILE_BUILD_FAILED");
  assert.equal(result.status, 1);
});
