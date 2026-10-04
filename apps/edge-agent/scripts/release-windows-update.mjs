import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureWindowsHelperDirectory,
  inspectPrivateFile,
  securePrivateDirectory,
} from "@laundry/platform-fs";
import { stageWindowsProfile } from "./windows-profile.mjs";
import {
  ReleaseManifestAuthoritySchema,
  signReleaseManifest,
} from "../dist/upgrade/release-manifest.js";
import { parseUpdateConfiguration } from "../dist/upgrade/update-config.js";
import { createWindowsUpdateIo } from "../dist/upgrade/windows-update-io.js";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
function fail() {
  throw new Error("WINDOWS_UPDATE_RELEASE_INPUT_INVALID");
}
function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail();
  return value;
}
export function parseWindowsUpdateEnvironment(env, platform = process.platform) {
  if (platform !== "win32") throw new Error("WINDOWS_UPDATE_RELEASE_REQUIRES_WINDOWS");
  const profile = required(env, "LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE");
  const version = required(env, "LAUNDRY_WINDOWS_UPDATE_VERSION");
  const certificate = required(env, "LAUNDRY_WINDOWS_SIGNING_THUMBPRINT");
  const gitSha = required(env, "LAUNDRY_WINDOWS_BUILD_GIT_SHA");
  if (
    !/^(generic|hongfa)$/u.test(profile) ||
    !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(version) ||
    !/^[a-fA-F0-9]{40}$/u.test(certificate) ||
    !/^[a-f0-9]{40}$/u.test(gitSha)
  )
    fail();
  const paths = Object.fromEntries(
    [
      ["privateKey", "LAUNDRY_UPDATE_PRIVATE_KEY_FILE"],
      ["publicKey", "LAUNDRY_UPDATE_PUBLIC_KEY_FILE"],
      ["policy", "LAUNDRY_RELEASE_POLICY_FILE"],
      ["config", "LAUNDRY_UPDATE_CONFIG_FILE"],
      ["destination", "LAUNDRY_WINDOWS_UPDATE_OUTPUT"],
    ].map(([key, variable]) => {
      const path = required(env, variable);
      if (!isAbsolute(path) || resolve(path) !== path) fail();
      return [key, path];
    }),
  );
  return Object.freeze({ profile, version, certificate, gitSha, ...paths });
}
async function boundedFile(path, limit) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > limit
  )
    fail();
  const bytes = await readFile(path);
  if (bytes.length !== info.size) fail();
  return bytes;
}

export async function releaseWindowsUpdate(env = process.env) {
  const input = parseWindowsUpdateEnvironment(env);
  const git = promisify(execFile);
  const head = await git("git.exe", ["rev-parse", "HEAD"], { cwd: PACKAGE_ROOT, timeout: 10000 });
  const status = await git("git.exe", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: PACKAGE_ROOT,
    timeout: 10000,
  });
  if (head.stdout.trim() !== input.gitSha || status.stdout.trim() !== "")
    throw new Error("WINDOWS_UPDATE_SOURCE_NOT_CLEAN");
  configureWindowsHelperDirectory(join(PACKAGE_ROOT, "resources", "windows-helper"));
  await inspectPrivateFile(input.privateKey);
  const secret = await boundedFile(input.privateKey, 16384);
  let privateKey;
  try {
    privateKey = createPrivateKey(secret);
  } finally {
    secret.fill(0);
  }
  const publicKey = createPublicKey(await boundedFile(input.publicKey, 16384));
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .equals(publicKey.export({ type: "spki", format: "der" }))
  )
    fail();
  const configuration = parseUpdateConfiguration(
    JSON.parse((await boundedFile(input.config, 16384)).toString("utf8")),
  );
  if (!configuration.enabled) fail();
  const policy = JSON.parse((await boundedFile(input.policy, 65536)).toString("utf8"));
  const name = `laundry-v2-${input.profile}-${input.version}-windows-x64.zip`;
  const authority = ReleaseManifestAuthoritySchema.parse({
    ...policy,
    protocol_version: 1,
    target: { platform: "win32", arch: "x64", profile: input.profile },
    version: input.version,
    published_at: new Date().toISOString(),
    artifacts: [{ kind: "zip", name, size_bytes: 1, sha256: "0".repeat(64) }],
  });
  if (
    authority.channel !== configuration.channel ||
    authority.local_schema !== 3 ||
    authority.contracts_major !== 0 ||
    authority.rollback === null
  )
    fail();
  const parent = await lstat(dirname(input.destination));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail();
  const staging = join(dirname(input.destination), `.windows-update-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  await securePrivateDirectory(staging);
  let published = false;
  try {
    await mkdir(join(staging, "input"), { mode: 0o700 });
    const staged = await stageWindowsProfile({
      profileId: input.profile,
      packageVersion: input.version,
      expectedGitSha: input.gitSha,
      targetRoot: join(staging, "input", "windows-profile"),
    });
    const keyPath = join(staging, "update-public-key.pem");
    const configPath = join(staging, "update-config.json");
    await writeFile(keyPath, publicKey.export({ type: "spki", format: "pem" }), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(configPath, `${JSON.stringify(configuration)}\n`, { flag: "wx", mode: 0o600 });
    const { build, Platform, Arch } = await import("electron-builder");
    await build({
      projectDir: PACKAGE_ROOT,
      publish: "never",
      targets: Platform.WINDOWS.createTarget(["nsis", "zip"], Arch.x64),
      config: {
        extends: join(PACKAGE_ROOT, "electron-builder.yml"),
        ...staged.settings.overrides,
        forceCodeSigning: true,
        extraMetadata: { ...staged.settings.overrides.extraMetadata, version: input.version },
        directories: { output: staging },
        extraResources: [
          { from: "resources/spa", to: "spa" },
          { from: keyPath, to: "update/update-public-key.pem" },
          { from: configPath, to: "update/update-config.json" },
        ],
        win: {
          ...staged.settings.overrides.win,
          signExecutable: true,
          signtoolOptions: { certificateSha1: input.certificate },
          artifactName: name.replace(/\.zip$/u, ".${ext}"),
          extraResources: [
            {
              from: staged.targetRoot,
              to: "distribution-profile",
              filter: ["profile.json", "binding.json"],
            },
            {
              from: "resources/windows-helper",
              to: "windows-helper",
              filter: ["laundry-windows-helper.exe", "laundry-windows-helper.exe.sha256"],
            },
            {
              from: "resources/windows-helper/windows-build-provenance.json",
              to: "build-provenance/windows-source.json",
            },
          ],
        },
      },
    });
    const artifact = join(staging, name);
    const info = await lstat(artifact);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024 ** 3) fail();
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(artifact)) hash.update(bytes);
    const manifest = signReleaseManifest(
      {
        ...authority,
        artifacts: [{ kind: "zip", name, size_bytes: info.size, sha256: hash.digest("hex") }],
      },
      privateKey,
    );
    const verification = join(staging, "verification");
    await mkdir(verification, { mode: 0o700 });
    await securePrivateDirectory(verification);
    const { copyFile } = await import("node:fs/promises");
    await copyFile(artifact, join(verification, name));
    const executable = join(staging, "win-unpacked", staged.settings.executableFileName);
    await createWindowsUpdateIo(executable).extractAndVerifyWindowsApp(
      join(verification, name),
      verification,
      manifest,
    );
    await rm(verification, { recursive: true });
    await writeFile(
      join(staging, "latest-laundry-v2.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    // Atomic publication into a previously absent directory; never overwrite an existing release.
    try {
      await lstat(input.destination);
      throw new Error("WINDOWS_UPDATE_RELEASE_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(staging, input.destination);
    published = true;
    return Object.freeze({
      profile: input.profile,
      version: input.version,
      source_git_sha: input.gitSha,
      artifact_sha256: manifest.authority.artifacts[0].sha256,
    });
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail();
    console.log("WINDOWS_UPDATE_RELEASE_OK " + JSON.stringify(await releaseWindowsUpdate()));
  } catch {
    console.error("WINDOWS_UPDATE_RELEASE_FAILED");
    process.exitCode = 1;
  }
}
