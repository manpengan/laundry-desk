import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  activeBundleRootFromSpaRoot,
  loadCanonicalManifest,
  verifySpaIntegrity,
} from "../dist/lib/integrity.js";
import { planSpaRetention } from "./prune-packaged-spa.mjs";
import { parseWindowsBuildProvenance } from "./stage-windows-helper.mjs";

const APP_ID = "com.laundry-desk.v2";
const APP_EXECUTABLE = "laundry-desk V2.exe";
const INSTALLER = "laundry-desk-v2-0.1.0-windows-x64-development-only.exe";
const PACKAGE_VERSION = "0.1.0";
const HELPER = "laundry-windows-helper.exe";
const PROVENANCE = "windows-source.json";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const RELEASE_ROOT = join(PACKAGE_ROOT, "release");
const SHA256 = /^[0-9a-f]{64}$/u;
const execFileAsync = promisify(execFile);

function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function assertRealDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function openRegularUniqueFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = await handle.stat();
  if (
    !opened.isFile() ||
    opened.dev !== metadata.dev ||
    opened.ino !== metadata.ino ||
    opened.nlink !== 1
  ) {
    await handle.close();
    throw new Error(`${label} changed while opening`);
  }
  return Object.freeze({ handle, metadata: opened });
}

async function readBoundedFile(path, label, maximumBytes) {
  const { handle, metadata } = await openRegularUniqueFile(path, label);
  try {
    if (metadata.size < 1 || metadata.size > maximumBytes) {
      throw new Error(`${label} has an invalid size`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertSizedFile(path, label, maximumBytes) {
  const { handle, metadata } = await openRegularUniqueFile(path, label);
  await handle.close();
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }
}

async function sha256File(path, label) {
  const { handle } = await openRegularUniqueFile(path, label);
  try {
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function assertX64Pe(path) {
  const { handle, metadata } = await openRegularUniqueFile(path, "packaged Windows executable");
  try {
    if (metadata.size < 70) throw new Error("packaged Windows executable is too small");
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length) {
      throw new Error("packaged Windows DOS header is incomplete");
    }
    if (dos.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("packaged Windows DOS signature is invalid");
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > metadata.size - 6) {
      throw new Error("packaged Windows PE offset is invalid");
    }
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, peOffset)).bytesRead !== pe.length) {
      throw new Error("packaged Windows PE header is incomplete");
    }
    if (pe.toString("binary", 0, 4) !== "PE\0\0" || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error("packaged Windows executable must be x64 PE");
    }
  } finally {
    await handle.close();
  }
}

function parseDisabledUpdateConfig(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("packaged development update configuration is invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["enabled", "schema_version"]) ||
    parsed.schema_version !== 1 ||
    parsed.enabled !== false
  ) {
    throw new Error("packaged development update configuration must be exactly disabled");
  }
}

async function defaultSignatureStatus(path) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) {
    throw new Error("Windows system root is unavailable");
  }
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await execFileAsync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $env:LAUNDRY_INSPECT_PATH).Status.ToString()",
    ],
    {
      encoding: "utf8",
      env: {
        LAUNDRY_INSPECT_PATH: path,
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      },
      maxBuffer: 8_192,
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (result.stderr !== "" || !/^[A-Za-z]+\r?\n?$/u.test(result.stdout)) {
    throw new Error("Authenticode status output is invalid");
  }
  return result.stdout.trim();
}

async function canonicalReleaseRoot(releaseRoot) {
  if (!isAbsolute(releaseRoot)) throw new Error("Windows release root must be absolute");
  await assertRealDirectory(releaseRoot, "Windows release root");
  const canonical = await realpath(releaseRoot);
  if (canonical !== releaseRoot) throw new Error("Windows release root must be canonical");
  return canonical;
}

export async function inspectPackagedWindowsSoftware(options = {}) {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("Windows package inspection requires win32");
  }
  const releaseRoot = await canonicalReleaseRoot(options.releaseRoot ?? RELEASE_ROOT);
  const expectedGitSha = options.expectedGitSha;
  const signatureStatus = options.signatureStatus ?? defaultSignatureStatus;
  const appRoot = join(releaseRoot, "win-unpacked");
  const executablePath = join(appRoot, APP_EXECUTABLE);
  const installerPath = join(releaseRoot, INSTALLER);
  const blockmapPath = `${installerPath}.blockmap`;
  await assertRealDirectory(appRoot, "unpacked Windows application");
  if (!isWithin(releaseRoot, await realpath(appRoot))) {
    throw new Error("unpacked Windows application escapes its release root");
  }
  await assertX64Pe(executablePath);
  await Promise.all([
    assertSizedFile(installerPath, "development-only NSIS installer", 256 * 1024 * 1024),
    assertSizedFile(blockmapPath, "development-only NSIS blockmap", 2 * 1024 * 1024),
  ]);

  const resourcesPath = join(appRoot, "resources");
  await assertRealDirectory(resourcesPath, "packaged Windows resources");
  await assertSizedFile(join(resourcesPath, "app.asar"), "packaged app.asar", 64 * 1024 * 1024);
  const updatePath = join(resourcesPath, "update");
  await assertRealDirectory(updatePath, "packaged update directory");
  const updateEntries = await readdir(updatePath, { withFileTypes: true });
  if (
    updateEntries.length !== 1 ||
    updateEntries[0]?.name !== "update-config.json" ||
    !updateEntries[0].isFile()
  ) {
    throw new Error("local package update resources must contain only its disabled configuration");
  }
  parseDisabledUpdateConfig(
    await readBoundedFile(
      join(updatePath, "update-config.json"),
      "packaged development update configuration",
      4_096,
    ),
  );

  const helperRoot = join(resourcesPath, "windows-helper");
  await assertRealDirectory(helperRoot, "packaged Windows helper directory");
  const helperEntries = (await readdir(helperRoot)).sort();
  if (JSON.stringify(helperEntries) !== JSON.stringify([HELPER, `${HELPER}.sha256`])) {
    throw new Error("packaged Windows helper directory is not exact");
  }
  const helperPath = join(helperRoot, HELPER);
  const helperDigest = (
    await readBoundedFile(`${helperPath}.sha256`, "packaged Windows helper digest", 128)
  )
    .toString("ascii")
    .trim();
  if (
    !SHA256.test(helperDigest) ||
    (await sha256File(helperPath, "packaged Windows helper")) !== helperDigest
  ) {
    throw new Error("packaged Windows helper digest does not match");
  }

  const provenanceRoot = join(resourcesPath, "build-provenance");
  await assertRealDirectory(provenanceRoot, "packaged Windows build provenance directory");
  const provenanceEntries = await readdir(provenanceRoot, { withFileTypes: true });
  if (
    provenanceEntries.length !== 1 ||
    provenanceEntries[0]?.name !== PROVENANCE ||
    !provenanceEntries[0].isFile()
  ) {
    throw new Error("packaged Windows build provenance directory is not exact");
  }
  const provenanceBytes = await readBoundedFile(
    join(provenanceRoot, PROVENANCE),
    "packaged Windows build provenance",
    1_024,
  );
  const provenance = parseWindowsBuildProvenance(provenanceBytes, {
    expectedGitSha,
    expectedHelperDigest: helperDigest,
  });

  const spaPath = await realpath(join(resourcesPath, "spa"));
  if (!isWithin(appRoot, spaPath)) throw new Error("packaged SPA escapes its application");
  const retention = await planSpaRetention(spaPath);
  if (retention.bundle_count !== 1 || retention.inactive_bundles.length !== 0) {
    throw new Error("packaged SPA must contain exactly its active bundle");
  }
  const loaded = loadCanonicalManifest(join(spaPath, "manifest.json"));
  if (loaded.bundleId !== retention.active_bundle) {
    throw new Error("packaged SPA manifest and active bundle disagree");
  }
  verifySpaIntegrity(activeBundleRootFromSpaRoot(spaPath, loaded.bundleId), loaded.manifest);

  const [appSignature, installerSignature] = await Promise.all([
    signatureStatus(executablePath),
    signatureStatus(installerPath),
  ]);
  if (appSignature !== "NotSigned" || installerSignature !== "NotSigned") {
    throw new Error("development-only Windows artifacts must be explicitly unsigned");
  }
  return Object.freeze({
    app_id: APP_ID,
    app_sha256: await sha256File(executablePath, "packaged Windows executable"),
    architecture: "x64",
    assurance: "software_only",
    helper_sha256: helperDigest,
    installer_sha256: await sha256File(installerPath, "development-only NSIS installer"),
    provenance_sha256: createHash("sha256").update(provenanceBytes).digest("hex"),
    signatures: "NotSigned",
    source_git_sha: provenance.source_git_sha,
    source_tree: provenance.source_tree,
    spa_bundle: loaded.bundleId,
    spa_entry_count: Object.keys(loaded.manifest.entries).length,
    version: PACKAGE_VERSION,
  });
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  if (process.argv.length !== 2) {
    process.stderr.write("WINDOWS_PACKAGE_SOFTWARE_ARGS_INVALID\n");
    process.exitCode = 1;
  } else {
    inspectPackagedWindowsSoftware({
      expectedGitSha: process.env.LAUNDRY_WINDOWS_BUILD_GIT_SHA,
    })
      .then((evidence) =>
        process.stdout.write(`WINDOWS_PACKAGE_SOFTWARE_OK ${JSON.stringify(evidence)}\n`),
      )
      .catch(() => {
        process.stderr.write("WINDOWS_PACKAGE_SOFTWARE_FAILED\n");
        process.exitCode = 1;
      });
  }
}
