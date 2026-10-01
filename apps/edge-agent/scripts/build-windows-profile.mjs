import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS_PROFILE_IDS, stageWindowsProfile } from "./windows-profile.mjs";
import { WINDOWS_PACKAGE_VERSION } from "./windows-package-version.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

export function requireWindowsBuildProfile(value = "generic") {
  if (!WINDOWS_PROFILE_IDS.includes(value)) throw new Error("WINDOWS_PROFILE_ID_INVALID");
  return value;
}

export function windowsBuilderConfiguration(staged) {
  const { settings, targetRoot } = staged;
  requireWindowsBuildProfile(settings.profileId);
  return {
    ...settings.overrides,
    directories: { output: "release/" + settings.profileId },
    win: {
      ...settings.overrides.win,
      extraResources: [
        { from: targetRoot, to: "distribution-profile", filter: ["profile.json", "binding.json"] },
        { from: "resources/windows-runtime-guide.txt", to: "windows-runtime-guide.txt" },
      ],
    },
    nsis: { ...settings.overrides.nsis, include: "build/windows-runtime-guide.nsh" },
  };
}

export async function buildWindowsProfile({
  profileId = "generic",
  expectedGitSha,
  packageRoot = PACKAGE_ROOT,
  builder,
} = {}) {
  requireWindowsBuildProfile(profileId);
  if (process.platform !== "win32") throw new Error("WINDOWS_PROFILE_BUILD_REQUIRES_WIN32");
  const parent = join(packageRoot, "dist", "profile-" + profileId);
  await mkdir(parent, { recursive: true });
  const staged = await stageWindowsProfile({
    profileId,
    expectedGitSha,
    packageVersion: WINDOWS_PACKAGE_VERSION,
    targetRoot: join(parent, "windows-profile"),
  });
  const { build, Platform, Arch } = builder ?? (await import("electron-builder"));
  await build({
    projectDir: packageRoot,
    config: windowsBuilderConfiguration(staged),
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
    publish: "never",
  });
  return staged.binding;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("WINDOWS_PROFILE_BUILD_ARGS_INVALID");
    const binding = await buildWindowsProfile({
      profileId: process.env.LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE ?? "generic",
      expectedGitSha: process.env.LAUNDRY_WINDOWS_BUILD_GIT_SHA,
    });
    console.log("WINDOWS_PROFILE_BUILD_OK " + JSON.stringify(binding));
  } catch (error) {
    console.error(
      /^WINDOWS_PROFILE_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_PROFILE_BUILD_FAILED",
    );
    process.exitCode = 1;
    // Builder shutdown callbacks must not replace the failed CLI exit status.
    process.on("exit", () => {
      process.exitCode = 1;
    });
  }
}
