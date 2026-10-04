import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SOURCE_ROOT = join(PACKAGE_ROOT, "resources", "windows-profiles");
const TARGET_ROOT = join(PACKAGE_ROOT, "dist", "windows-profile");
const MAXIMUM_BYTES = 8 * 1024;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/u;
const PROFILES = Object.freeze({
  generic: Object.freeze({ displayName: "laundry-desk V2", appId: "com.laundry-desk.v2" }),
  hongfa: Object.freeze({
    displayName: "宏发洗衣 V2（开发版）",
    appId: "com.laundry-desk.v2.hongfa",
  }),
});
const PROFILE_KEYS = Object.freeze([
  "schema_version",
  "assurance",
  "profile_id",
  "display_name",
  "icon_path",
  "service_origin",
  "app_id",
  "device_types",
]);
const BINDING_KEYS = Object.freeze([
  "schema_version",
  "assurance",
  "profile_id",
  "profile_sha256",
  "source_git_sha",
]);
const STAGED_FILES = Object.freeze(["binding.json", "profile.json"]);

export const WINDOWS_PROFILE_IDS = Object.freeze(Object.keys(PROFILES));

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function requireProfileId(value) {
  if (typeof value !== "string" || !Object.hasOwn(PROFILES, value))
    fail("WINDOWS_PROFILE_ID_INVALID");
  return value;
}

export function validateWindowsProfile(value, { expectedProfileId } = {}) {
  if (!exactKeys(value, PROFILE_KEYS)) fail("WINDOWS_PROFILE_INVALID");
  const profileId = requireProfileId(value.profile_id);
  const allowed = PROFILES[profileId];
  if (
    (expectedProfileId !== undefined && profileId !== requireProfileId(expectedProfileId)) ||
    value.schema_version !== 1 ||
    value.assurance !== "development_only" ||
    value.display_name !== allowed.displayName ||
    value.app_id !== allowed.appId ||
    value.icon_path !== "build/icon.ico" ||
    value.service_origin !== "http://127.0.0.1:8787" ||
    !Array.isArray(value.device_types) ||
    value.device_types.length !== 1 ||
    value.device_types[0] !== "windows-spooler-raw"
  )
    fail("WINDOWS_PROFILE_INVALID");
  return Object.freeze({
    schema_version: 1,
    assurance: "development_only",
    profile_id: profileId,
    display_name: value.display_name,
    icon_path: value.icon_path,
    service_origin: value.service_origin,
    app_id: value.app_id,
    device_types: Object.freeze([...value.device_types]),
  });
}

export function windowsProfileBytes(profile) {
  const text = JSON.stringify(validateWindowsProfile(profile), null, 2).replace(
    '[\n    "windows-spooler-raw"\n  ]',
    '["windows-spooler-raw"]',
  );
  return Buffer.from(`${text}\n`, "utf8");
}

function parseJson(bytes, code) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_BYTES)
    fail(code);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
}

export function parseWindowsProfile(bytes, options = {}) {
  const profile = validateWindowsProfile(parseJson(bytes, "WINDOWS_PROFILE_INVALID"), options);
  if (!Buffer.from(bytes).equals(windowsProfileBytes(profile)))
    fail("WINDOWS_PROFILE_NONCANONICAL");
  return profile;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function getWindowsProfileBuildSettings(rawProfile, { packageVersion = "0.1.0" } = {}) {
  const profile = validateWindowsProfile(rawProfile);
  if (typeof packageVersion !== "string" || !VERSION.test(packageVersion))
    fail("WINDOWS_PROFILE_VERSION_INVALID");
  const prefix = profile.profile_id === "generic" ? "laundry-desk-v2" : "laundry-desk-v2-hongfa";
  const installerFileName = `${prefix}-${packageVersion}-windows-x64-development-only.exe`;
  return Object.freeze({
    profileId: profile.profile_id,
    appId: profile.app_id,
    displayName: profile.display_name,
    serviceOrigin: profile.service_origin,
    executableFileName: `${profile.display_name}.exe`,
    installerFileName,
    // ADR-91 P1-7: the packaged name gives each distribution its own ASCII userData,
    // single-instance lock and per-user install directory.
    packageName: prefix,
    profileDigest: digest(windowsProfileBytes(profile)),
    overrides: Object.freeze({
      appId: profile.app_id,
      productName: profile.display_name,
      extraMetadata: Object.freeze({ name: prefix }),
      win: Object.freeze({ icon: "../../build/icon.ico" }),
      nsis: Object.freeze({ artifactName: installerFileName }),
    }),
  });
}

async function requireRealDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    fail("WINDOWS_PROFILE_DIRECTORY_INVALID");
}

async function requireRealAncestors(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("WINDOWS_PROFILE_PATH_INVALID");
  for (let current = path; ; current = dirname(current)) {
    await requireRealDirectory(current);
    if (dirname(current) === current) break;
  }
  return await realpath(path);
}

async function readRegularBoundedFile(path) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > MAXIMUM_BYTES
  )
    fail("WINDOWS_PROFILE_FILE_INVALID");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs ||
      !opened.isFile()
    )
      fail("WINDOWS_PROFILE_FILE_CHANGED");
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      bytesRead !== before.size ||
      [after, pathAfter].some(
        (entry) =>
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          entry.dev !== before.dev ||
          entry.ino !== before.ino ||
          entry.size !== before.size ||
          entry.mtimeMs !== before.mtimeMs ||
          entry.ctimeMs !== before.ctimeMs ||
          entry.nlink !== 1,
      )
    )
      fail("WINDOWS_PROFILE_FILE_CHANGED");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function loadWindowsProfile({ profileId = "generic", sourceRoot = SOURCE_ROOT } = {}) {
  requireProfileId(profileId);
  const source = await requireRealAncestors(sourceRoot);
  const bytes = await readRegularBoundedFile(join(source, `${profileId}.json`));
  const profile = parseWindowsProfile(bytes, { expectedProfileId: profileId });
  return Object.freeze({ profile, digest: digest(bytes) });
}

function bindingBytes(binding) {
  return Buffer.from(`${JSON.stringify(binding, null, 2)}\n`, "utf8");
}

function requireBinding(bytes, expected) {
  const binding = parseJson(bytes, "WINDOWS_PROFILE_BINDING_INVALID");
  if (
    !exactKeys(binding, BINDING_KEYS) ||
    binding.schema_version !== 1 ||
    binding.assurance !== "development_only" ||
    binding.profile_id !== expected.profileId ||
    binding.profile_sha256 !== expected.digest ||
    binding.source_git_sha !== expected.expectedGitSha ||
    !GIT_SHA.test(binding.source_git_sha) ||
    !SHA256.test(binding.profile_sha256) ||
    !Buffer.from(bytes).equals(bindingBytes(binding))
  )
    fail("WINDOWS_PROFILE_BINDING_INVALID");
  return Object.freeze({ ...binding });
}

async function inspectDirectory(directory, { expectedProfileId, expectedGitSha }) {
  const root = await requireRealAncestors(directory);
  const entries = await readdir(root, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(STAGED_FILES)
  )
    fail("WINDOWS_PROFILE_CONTENT_INVALID");
  const bytes = await readRegularBoundedFile(join(root, "profile.json"));
  const profile = parseWindowsProfile(bytes, { expectedProfileId });
  const profileDigest = digest(bytes);
  const binding = requireBinding(await readRegularBoundedFile(join(root, "binding.json")), {
    profileId: expectedProfileId,
    digest: profileDigest,
    expectedGitSha,
  });
  return Object.freeze({ profile, digest: profileDigest, targetRoot: root, binding });
}

export async function stageWindowsProfile({
  profileId = "generic",
  sourceRoot = SOURCE_ROOT,
  targetRoot = TARGET_ROOT,
  expectedGitSha,
  packageVersion = "0.1.0",
} = {}) {
  if (
    !GIT_SHA.test(expectedGitSha ?? "") ||
    typeof targetRoot !== "string" ||
    !isAbsolute(targetRoot) ||
    basename(targetRoot) !== "windows-profile"
  )
    fail("WINDOWS_PROFILE_STAGING_ARGS_INVALID");
  const loaded = await loadWindowsProfile({ profileId, sourceRoot });
  const settings = getWindowsProfileBuildSettings(loaded.profile, { packageVersion });
  const parent = await requireRealAncestors(dirname(targetRoot));
  const target = join(parent, "windows-profile");
  const binding = Object.freeze({
    schema_version: 1,
    assurance: "development_only",
    profile_id: profileId,
    profile_sha256: loaded.digest,
    source_git_sha: expectedGitSha,
  });
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await inspectDirectory(target, {
      expectedProfileId: profileId,
      expectedGitSha,
    });
    if (existing.digest !== loaded.digest) fail("WINDOWS_PROFILE_STAGING_CONFLICT");
    return Object.freeze({ ...existing, settings });
  }
  await writeFile(join(target, "profile.json"), windowsProfileBytes(loaded.profile), {
    flag: "wx",
  });
  await writeFile(join(target, "binding.json"), bindingBytes(binding), { flag: "wx" });
  const staged = await inspectDirectory(target, { expectedProfileId: profileId, expectedGitSha });
  return Object.freeze({ ...staged, settings });
}

export async function inspectPackagedWindowsProfile({
  resourcesPath,
  expectedProfileId = "generic",
  expectedGitSha,
} = {}) {
  requireProfileId(expectedProfileId);
  if (
    !GIT_SHA.test(expectedGitSha ?? "") ||
    typeof resourcesPath !== "string" ||
    !isAbsolute(resourcesPath)
  )
    fail("WINDOWS_PROFILE_INSPECTION_ARGS_INVALID");
  return await inspectDirectory(join(resourcesPath, "distribution-profile"), {
    expectedProfileId,
    expectedGitSha,
  });
}
