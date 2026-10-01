import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
