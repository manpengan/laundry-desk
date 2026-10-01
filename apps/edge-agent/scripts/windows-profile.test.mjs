import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  WINDOWS_PROFILE_IDS,
  getWindowsProfileBuildSettings,
  inspectPackagedWindowsProfile,
  loadWindowsProfile,
  parseWindowsProfile,
  stageWindowsProfile,
  validateWindowsProfile,
  windowsProfileBytes,
} from "./windows-profile.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

async function fixture(t, profileId = "generic") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-win-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const buildRoot = join(root, "build");
  const resourcesPath = join(root, "resources");
  await Promise.all([mkdir(sourceRoot), mkdir(buildRoot), mkdir(resourcesPath)]);
  const loaded = await loadWindowsProfile({ profileId });
  await writeFile(join(sourceRoot, `${profileId}.json`), windowsProfileBytes(loaded.profile));
  return {
    root,
    sourceRoot,
    resourcesPath,
    targetRoot: join(buildRoot, "windows-profile"),
    ...loaded,
  };
}

async function stagedFixture(t, profileId = "generic") {
  const value = await fixture(t, profileId);
  const staged = await stageWindowsProfile({ ...value, profileId, expectedGitSha: SHA });
  await cp(staged.targetRoot, join(value.resourcesPath, "distribution-profile"), {
    recursive: true,
  });
  return { ...value, staged };
}

test("allowlisted profiles preserve generic identity and separate Hongfa packaging identity", async () => {
  assert.deepEqual(WINDOWS_PROFILE_IDS, ["generic", "hongfa"]);
  const generic = await loadWindowsProfile();
  const hongfa = await loadWindowsProfile({ profileId: "hongfa" });
  const genericSettings = getWindowsProfileBuildSettings(generic.profile);
  const hongfaSettings = getWindowsProfileBuildSettings(hongfa.profile);
  assert.equal(genericSettings.appId, "com.laundry-desk.v2");
  assert.equal(genericSettings.executableFileName, "laundry-desk V2.exe");
  assert.equal(
    genericSettings.installerFileName,
    "laundry-desk-v2-0.1.0-windows-x64-development-only.exe",
  );
  assert.equal(hongfaSettings.appId, "com.laundry-desk.v2.hongfa");
  assert.equal(
    hongfaSettings.installerFileName,
    "laundry-desk-v2-hongfa-0.1.0-windows-x64-development-only.exe",
  );
  assert.equal(hongfaSettings.serviceOrigin, "http://127.0.0.1:8787");
  assert.notEqual(generic.digest, hongfa.digest);
  assert.equal(hongfa.digest, hongfaSettings.profileDigest);
  assert(Object.isFrozen(hongfa.profile));
  assert(Object.isFrozen(hongfa.profile.device_types));
  assert(Object.isFrozen(hongfaSettings.overrides.win));
  assert.deepEqual(hongfaSettings.overrides.nsis, {
    artifactName: hongfaSettings.installerFileName,
  });
});

test("unknown profile identities and source/profile identity swaps are refused", async () => {
  const { profile } = await loadWindowsProfile();
  await assert.rejects(
    loadWindowsProfile({ profileId: "../generic" }),
    /WINDOWS_PROFILE_ID_INVALID/u,
  );
  await assert.rejects(
    loadWindowsProfile({ profileId: "production" }),
    /WINDOWS_PROFILE_ID_INVALID/u,
  );
  assert.throws(
    () => validateWindowsProfile(profile, { expectedProfileId: "hongfa" }),
    /WINDOWS_PROFILE_INVALID/u,
  );
});

test("schema rejects every unsupported field, secret, tenant or business override", async () => {
  const { profile } = await loadWindowsProfile();
  for (const key of [
    "password",
    "pin",
    "token",
    "private_key",
    "database_url",
    "org_id",
    "store_id",
    "price",
    "endpoint",
    "customer",
  ]) {
    assert.throws(
      () => validateWindowsProfile({ ...profile, [key]: "canary" }),
      /WINDOWS_PROFILE_INVALID/u,
    );
  }
  const missing = Object.fromEntries(
    Object.entries(profile).filter(([key]) => key !== "icon_path"),
  );
  assert.throws(() => validateWindowsProfile(missing), /WINDOWS_PROFILE_INVALID/u);
  assert.throws(() => validateWindowsProfile(null), /WINDOWS_PROFILE_INVALID/u);
  assert.throws(() => validateWindowsProfile([]), /WINDOWS_PROFILE_INVALID/u);
});

test("fixed loopback origin rejects alternate hosts, ports, URLs and credentials", async () => {
  const { profile } = await loadWindowsProfile();
  for (const service_origin of [
    "http://localhost:8787",
    "http://0.0.0.0:8787",
    "http://[::1]:8787",
    "http://127.0.0.1:8788",
    "https://127.0.0.1:8787",
    "http://127.0.0.1:8787/",
    "http://127.0.0.1:8787?x=1",
    "http://user:canary@127.0.0.1:8787",
    "https://example.test",
    " http://127.0.0.1:8787",
  ]) {
    assert.throws(
      () => validateWindowsProfile({ ...profile, service_origin }),
      /WINDOWS_PROFILE_INVALID/u,
    );
  }
});

test("branding, installer ID, icon and device types cannot escape the code allowlist", async () => {
  const { profile } = await loadWindowsProfile();
  for (const patch of [
    { display_name: "Other brand" },
    { display_name: "a".repeat(9000) },
    { display_name: "app\nname" },
    { app_id: "com.other.application" },
    { icon_path: "../private/icon.ico" },
    { icon_path: "https://example.test/icon.ico" },
    { device_types: [] },
    { device_types: ["windows-spooler-raw", "windows-spooler-raw"] },
    { device_types: ["arbitrary-dll"] },
    { assurance: "production" },
    { schema_version: 2 },
  ])
    assert.throws(
      () => validateWindowsProfile({ ...profile, ...patch }),
      /WINDOWS_PROFILE_INVALID/u,
    );
  for (const packageVersion of ["", "0.1.0-beta", "../1.2.3", "1.2.3.exe", "9999999.1.1", null]) {
    assert.throws(
      () => getWindowsProfileBuildSettings(profile, { packageVersion }),
      /WINDOWS_PROFILE_VERSION_INVALID/u,
    );
  }
});

test("canonical bytes reject duplicate keys, malformed UTF-8, oversized JSON and secret-bearing errors", async () => {
  const { profile } = await loadWindowsProfile();
  const bytes = windowsProfileBytes(profile);
  assert.deepEqual(parseWindowsProfile(bytes), profile);
  const duplicated = Buffer.from(
    bytes
      .toString("utf8")
      .replace('"schema_version": 1,', '"schema_version": 1, "schema_version": 1,'),
  );
  for (const bad of [
    duplicated,
    Buffer.from(JSON.stringify(profile)),
    Buffer.from("{canary-secret"),
    Buffer.from([0xff]),
    Buffer.alloc(8193, 32),
  ]) {
    assert.throws(
      () => parseWindowsProfile(bad),
      (error) => {
        assert.match(error.message, /^WINDOWS_PROFILE_/u);
        assert.equal(error.cause, undefined);
        assert(!String(error).includes("canary-secret"));
        return true;
      },
    );
  }
});

test("staging binds source SHA and byte digest and is idempotent for identical build input", async (t) => {
  const value = await fixture(t, "hongfa");
  const options = { ...value, profileId: "hongfa", expectedGitSha: SHA };
  const first = await stageWindowsProfile(options);
  const second = await stageWindowsProfile(options);
  assert.deepEqual(first, second);
  assert.equal(first.binding.source_git_sha, SHA);
  assert.equal(
    first.binding.profile_sha256,
    createHash("sha256").update(windowsProfileBytes(value.profile)).digest("hex"),
  );
  assert.equal(first.settings.appId, value.profile.app_id);
  await assert.rejects(
    stageWindowsProfile({ ...options, expectedGitSha: OTHER_SHA }),
    /WINDOWS_PROFILE_BINDING_INVALID/u,
  );
  assert.equal(
    (await readFile(join(value.targetRoot, "binding.json"), "utf8")).includes(SHA),
    true,
  );
});

test("packaged profile verifies expected profile, source SHA and detached binding digest", async (t) => {
  const value = await stagedFixture(t, "hongfa");
  const options = {
    resourcesPath: value.resourcesPath,
    expectedProfileId: "hongfa",
    expectedGitSha: SHA,
  };
  const result = await inspectPackagedWindowsProfile(options);
  assert.equal(result.digest, value.digest);
  await assert.rejects(
    inspectPackagedWindowsProfile({ ...options, expectedGitSha: OTHER_SHA }),
    /WINDOWS_PROFILE_BINDING_INVALID/u,
  );
  await assert.rejects(
    inspectPackagedWindowsProfile({ ...options, expectedProfileId: "generic" }),
    /WINDOWS_PROFILE_INVALID/u,
  );
  const bindingPath = join(value.resourcesPath, "distribution-profile", "binding.json");
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  await writeFile(
    bindingPath,
    `${JSON.stringify({ ...binding, profile_sha256: "f".repeat(64) }, null, 2)}\n`,
  );
  await assert.rejects(inspectPackagedWindowsProfile(options), /WINDOWS_PROFILE_BINDING_INVALID/u);
});

test("packaged profile alteration and unknown files fail before returning packaging identity", async (t) => {
  const value = await stagedFixture(t);
  const options = { resourcesPath: value.resourcesPath, expectedGitSha: SHA };
  const profilePath = join(value.resourcesPath, "distribution-profile", "profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify({ ...value.profile, service_origin: "https://example.test" }, null, 2)}\n`,
  );
  await assert.rejects(inspectPackagedWindowsProfile(options), /WINDOWS_PROFILE_INVALID/u);
  await writeFile(profilePath, windowsProfileBytes(value.profile));
  await writeFile(join(value.resourcesPath, "distribution-profile", "other.json"), "{}\n");
  await assert.rejects(inspectPackagedWindowsProfile(options), /WINDOWS_PROFILE_CONTENT_INVALID/u);
});

test("unknown existing staging contents are preserved instead of overwritten", async (t) => {
  const value = await fixture(t);
  await mkdir(value.targetRoot);
  const marker = join(value.targetRoot, "operator-data.json");
  await writeFile(marker, "preserved\n");
  await assert.rejects(
    stageWindowsProfile({ ...value, expectedGitSha: SHA }),
    /WINDOWS_PROFILE_CONTENT_INVALID/u,
  );
  assert.equal(await readFile(marker, "utf8"), "preserved\n");
});

test("linked files cannot be used as trusted source or packaged profile", async (t) => {
  const value = await fixture(t);
  await link(join(value.sourceRoot, "generic.json"), join(value.root, "hardlink.json"));
  await assert.rejects(
    loadWindowsProfile({ sourceRoot: value.sourceRoot }),
    /WINDOWS_PROFILE_FILE_INVALID/u,
  );
  const staged = await stagedFixture(t);
  await link(
    join(staged.resourcesPath, "distribution-profile", "profile.json"),
    join(staged.root, "hardlink.json"),
  );
  await assert.rejects(
    inspectPackagedWindowsProfile({ resourcesPath: staged.resourcesPath, expectedGitSha: SHA }),
    /WINDOWS_PROFILE_FILE_INVALID/u,
  );
});

test("atomic path replacement during a read is refused", async (t) => {
  const value = await fixture(t);
  const path = join(value.sourceRoot, "generic.json");
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const originalOpen = fs.open;
    const path = process.argv[1];
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === path) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          await fs.rename(path, path + '.retained');
          await fs.writeFile(path, '{invalid');
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { loadWindowsProfile } = await import(process.argv[2]);
    try {
      await loadWindowsProfile({sourceRoot: process.argv[3]});
      process.exitCode = 1;
    } catch (error) {
      if (error.message !== 'WINDOWS_PROFILE_FILE_CHANGED') throw error;
    }
  `;
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    path,
    new URL("./windows-profile.mjs", import.meta.url).href,
    value.sourceRoot,
  ]);
  assert.equal(await readFile(path, "utf8"), "{invalid");
  assert.deepEqual(await readFile(`${path}.retained`), windowsProfileBytes(value.profile));
});

test(
  "symlinked input and staging ancestors are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const value = await fixture(t);
    const sourceAlias = join(value.root, "source-alias");
    await symlink(value.sourceRoot, sourceAlias, "dir");
    await assert.rejects(
      loadWindowsProfile({ sourceRoot: sourceAlias }),
      /WINDOWS_PROFILE_DIRECTORY_INVALID/u,
    );
    await assert.rejects(
      stageWindowsProfile({
        ...value,
        targetRoot: join(sourceAlias, "windows-profile"),
        expectedGitSha: SHA,
      }),
      /WINDOWS_PROFILE_DIRECTORY_INVALID/u,
    );
    const fileRoot = join(value.root, "file-source");
    await mkdir(fileRoot);
    await symlink(join(value.sourceRoot, "generic.json"), join(fileRoot, "generic.json"));
    await assert.rejects(
      loadWindowsProfile({ sourceRoot: fileRoot }),
      /WINDOWS_PROFILE_FILE_INVALID/u,
    );
  },
);

test("build and inspection arguments cannot select arbitrary staging roots or omit source identity", async (t) => {
  const value = await fixture(t);
  await assert.rejects(stageWindowsProfile({ ...value }), /WINDOWS_PROFILE_STAGING_ARGS_INVALID/u);
  await assert.rejects(
    stageWindowsProfile({ ...value, expectedGitSha: SHA, targetRoot: value.root }),
    /WINDOWS_PROFILE_STAGING_ARGS_INVALID/u,
  );
  await assert.rejects(
    inspectPackagedWindowsProfile({ resourcesPath: value.resourcesPath }),
    /WINDOWS_PROFILE_INSPECTION_ARGS_INVALID/u,
  );
  await assert.rejects(
    inspectPackagedWindowsProfile({ resourcesPath: "resources", expectedGitSha: SHA }),
    /WINDOWS_PROFILE_INSPECTION_ARGS_INVALID/u,
  );
});
