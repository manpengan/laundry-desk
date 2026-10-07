import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  activeBundleRootFromSpaRoot,
  isSpaManifest,
  serializeCanonicalManifest,
} from "../dist/lib/integrity.js";
import { parseWindowsBuildProvenance } from "./stage-windows-helper.mjs";
import {
  getWindowsProfileBuildSettings,
  inspectPackagedWindowsProfile,
} from "./windows-profile.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const WORKSPACE = fileURLToPath(new URL("../../../", import.meta.url));
const START_FILE = "functional-installation-start.json";
const RUNNER_PATHS = Object.freeze([
  "apps/edge-agent/e2e",
  "apps/edge-agent/playwright.electron.windows-functional.config.ts",
  "apps/edge-agent/scripts/windows-functional-evidence.mjs",
  "apps/edge-agent/scripts/windows-profile.mjs",
  "apps/edge-agent/scripts/stage-windows-helper.mjs",
]);
const REQUIRED_RUNNER_FILES = Object.freeze([
  "apps/edge-agent/e2e/windows-functional.spec.ts",
  "apps/edge-agent/scripts/windows-functional-evidence.mjs",
]);
const CHECKER_ARTIFACTS = Object.freeze([
  "apps/edge-agent/dist/lib/integrity.js",
  "apps/edge-agent/dist/lib/mime.js",
]);
const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireValue(condition, code) {
  if (!condition) throw new Error(`WINDOWS_FUNCTIONAL_EVIDENCE_${code}`);
}

async function realDirectory(path) {
  requireValue(
    typeof path === "string" && isAbsolute(path) && !path.includes("\0"),
    "PATH_INVALID",
  );
  for (let current = resolve(path); ; current = dirname(current)) {
    const info = await lstat(current);
    requireValue(info.isDirectory() && !info.isSymbolicLink(), "DIRECTORY_INVALID");
    if (dirname(current) === current) break;
  }
  return await realpath(path);
}

function sameFile(before, after) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.nlink === 1 &&
    ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => before[key] === after[key])
  );
}

// Bound both allocations and bytes streamed, checking the opened file and pathname again.
async function fingerprint(path, maximumBytes, includeBytes = false) {
  await realDirectory(dirname(path));
  const before = await lstat(path);
  requireValue(
    sameFile(before, before) && before.size > 0 && before.size <= maximumBytes,
    "FILE_INVALID",
  );
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    requireValue(sameFile(before, await handle.stat()), "FILE_CHANGED");
    const hash = createHash("sha256");
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      requireValue(size <= before.size && size <= maximumBytes, "FILE_CHANGED");
      hash.update(chunk);
      if (includeBytes) chunks.push(chunk);
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    requireValue(
      size === before.size && sameFile(before, after) && sameFile(before, pathAfter),
      "FILE_CHANGED",
    );
    await realDirectory(dirname(path));
    return Object.freeze({
      sha256: hash.digest("hex"),
      size,
      bytes: includeBytes ? Buffer.concat(chunks) : undefined,
    });
  } finally {
    await handle.close();
  }
}

async function readBounded(path, maximumBytes) {
  return (await fingerprint(path, maximumBytes, true)).bytes;
}

async function verifySpaTree(root, paths) {
  const expected = new Set(paths);
  const directories = new Set(
    paths.flatMap((path) => {
      const parts = path.split("/");
      return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  requireValue(directories.size <= 512, "SPA_SIZE_INVALID");
  const pending = [""];
  let visited = 0;
  while (pending.length > 0) {
    const prefix = pending.pop();
    const path = join(root, prefix);
    await realDirectory(path);
    for await (const entry of await opendir(path)) {
      requireValue(++visited <= 1025, "SPA_SIZE_INVALID");
      const child = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(child)) pending.push(child);
      else requireValue(entry.isFile() && expected.delete(child), "SPA_TREE_INVALID");
    }
    await realDirectory(path);
  }
  requireValue(expected.size === 0, "SPA_TREE_INVALID");
}

async function inspectSpa(resourcesPath) {
  const spa = join(resourcesPath, "spa");
  const bytes = await readBounded(join(spa, "manifest.json"), 256 * 1024);
  const manifest = JSON.parse(bytes.toString("utf8"));
  requireValue(
    isSpaManifest(manifest) && bytes.equals(Buffer.from(serializeCanonicalManifest(manifest))),
    "SPA_MANIFEST_INVALID",
  );
  const entries = Object.entries(manifest.entries);
  requireValue(entries.length > 0 && entries.length <= 512, "SPA_SIZE_INVALID");
  const bundle = digest(bytes);
  const root = activeBundleRootFromSpaRoot(spa, bundle);
  let total = 0;
  for (const [path, entry] of entries) {
    total += entry.bytes;
    requireValue(total <= 64 * 1024 * 1024, "SPA_SIZE_INVALID");
    const actual = await fingerprint(join(root, path), 16 * 1024 * 1024);
    requireValue(actual.sha256 === entry.sha256 && actual.size === entry.bytes, "SPA_FILE_INVALID");
  }
  await verifySpaTree(root, Object.keys(manifest.entries));
  requireValue(
    (await readBounded(join(spa, "manifest.json"), 256 * 1024)).equals(bytes),
    "SPA_CHANGED",
  );
  return Object.freeze({ bundle_sha256: bundle, entry_count: entries.length });
}

export async function inspectFunctionalInstallation({ executable, expectedGitSha, profileId }) {
  requireValue(
    SHA.test(expectedGitSha ?? "") && ["generic", "hongfa"].includes(profileId),
    "EXPECTATION_INVALID",
  );
  requireValue(typeof executable === "string" && isAbsolute(executable), "PATH_INVALID");
  const root = await realDirectory(dirname(executable));
  const resources = join(root, "resources");
  const exe = await fingerprint(executable, 256 * 1024 * 1024);
  const asar = await fingerprint(join(resources, "app.asar"), 64 * 1024 * 1024);
  const helperPath = join(resources, "windows-helper", "laundry-windows-helper.exe");
  const helper = await fingerprint(helperPath, 8 * 1024 * 1024);
  const sidecar = (await readBounded(`${helperPath}.sha256`, 128)).toString("ascii").trim();
  requireValue(DIGEST.test(sidecar) && sidecar === helper.sha256, "HELPER_INVALID");
  const provenanceBytes = await readBounded(
    join(resources, "build-provenance", "windows-source.json"),
    1024,
  );
  const provenance = parseWindowsBuildProvenance(provenanceBytes, {
    expectedGitSha,
    expectedHelperDigest: helper.sha256,
  });
  const profile = await inspectPackagedWindowsProfile({
    resourcesPath: resources,
    expectedProfileId: profileId,
    expectedGitSha,
  });
  const settings = getWindowsProfileBuildSettings(profile.profile);
  requireValue(basename(executable) === settings.executableFileName, "EXECUTABLE_INVALID");
  const binding = await fingerprint(join(resources, "distribution-profile", "binding.json"), 4096);
  return Object.freeze({
    executable_path: await realpath(executable),
    source_git_sha: provenance.source_git_sha,
    source_tree: provenance.source_tree,
    app_id: settings.appId,
    profile_id: profileId,
    profile_sha256: profile.digest,
    profile_binding_sha256: binding.sha256,
    provenance_sha256: digest(provenanceBytes),
    executable_sha256: exe.sha256,
    asar_sha256: asar.sha256,
    helper_sha256: helper.sha256,
    spa: await inspectSpa(resources),
  });
}

async function git(root, args) {
  const environment = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"].flatMap(
      (key) => (typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
    ),
  );
  const result = await execute(
    process.platform === "win32" ? "git.exe" : "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-C",
      root,
      ...args,
    ],
    {
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  requireValue(result.stderr === "", "RUNNER_GIT_DIAGNOSTIC");
  return result.stdout;
}

export async function inspectFunctionalRunner(repositoryRoot = WORKSPACE) {
  const root = await realDirectory(repositoryRoot);
  requireValue(
    (await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim())) === root,
    "RUNNER_ROOT_INVALID",
  );
  const sha = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  requireValue(SHA.test(sha), "RUNNER_SHA_INVALID");
  const files = (await git(root, ["ls-files", "-z", "--", ...RUNNER_PATHS]))
    .split("\0")
    .filter(Boolean)
    .sort();
  requireValue(
    files.length <= 128 && REQUIRED_RUNNER_FILES.every((file) => files.includes(file)),
    "RUNNER_FILES_INVALID",
  );
  const fingerprints = {};
  for (const file of files) {
    requireValue(
      !isAbsolute(file) && !file.includes("\\") && file.split("/").every((part) => part !== ".."),
      "RUNNER_FILES_INVALID",
    );
    fingerprints[file] = (await fingerprint(join(root, file), 1024 * 1024)).sha256;
  }
  const changes = await git(root, ["diff", "HEAD", "--name-only", "--", ...RUNNER_PATHS]);
  const checkerArtifacts = {};
  for (const file of CHECKER_ARTIFACTS) {
    checkerArtifacts[file] = (await fingerprint(join(root, file), 1024 * 1024)).sha256;
  }
  requireValue(
    (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() === sha,
    "RUNNER_CHANGED",
  );
  return Object.freeze({
    source_git_sha: sha,
    tracked_files_match_head: changes === "",
    tracked_files_sha256: Object.freeze(fingerprints),
    checker_artifacts_sha256: Object.freeze(checkerArtifacts),
  });
}

export async function beginFunctionalEvidence(options) {
  const started = new Date().toISOString();
  const evidenceRoot = await realDirectory(options.evidenceRoot);
  for (const name of [START_FILE, "functional-evidence.json", "functional-observations.json"]) {
    const existing = await lstat(join(evidenceRoot, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    requireValue(existing === null, "OUTPUT_EXISTS");
  }
  const start = Object.freeze({
    schema_version: 1,
    status: "started",
    run_id: randomUUID(),
    started_at_utc: started,
    installation: await inspectFunctionalInstallation(options),
    runner: await inspectFunctionalRunner(options.repositoryRoot),
    runtime: Object.freeze({
      status: "unverified",
      reason: "requires_separate_backend_identity_evidence",
    }),
  });
  const bytes = Buffer.from(`${JSON.stringify(start, null, 2)}\n`);
  await writeFile(join(evidenceRoot, START_FILE), bytes, { flag: "wx" });
  return digest(bytes);
}

export async function finishFunctionalEvidence(options) {
  requireValue(DIGEST.test(options.startDigest ?? ""), "START_DIGEST_INVALID");
  const evidenceRoot = await realDirectory(options.evidenceRoot);
  const bytes = await readBounded(join(evidenceRoot, START_FILE), 256 * 1024);
  requireValue(digest(bytes) === options.startDigest, "START_CHANGED");
  const start = JSON.parse(bytes.toString("utf8"));
  requireValue(start.schema_version === 1 && start.status === "started", "START_INVALID");
  const installation = await inspectFunctionalInstallation(options);
  const runner = await inspectFunctionalRunner(options.repositoryRoot);
  requireValue(
    JSON.stringify(installation) === JSON.stringify(start.installation),
    "INSTALLATION_CHANGED",
  );
  requireValue(JSON.stringify(runner) === JSON.stringify(start.runner), "RUNNER_CHANGED");
  const observations = JSON.parse(
    (await readBounded(join(evidenceRoot, "functional-observations.json"), 1024 * 1024)).toString(
      "utf8",
    ),
  );
  requireValue(
    observations !== null && !Array.isArray(observations) && observations.status === "observed",
    "OBSERVATIONS_INVALID",
  );
  const report = Object.freeze({
    ...observations,
    ...start,
    status: "passed",
    finished_at_utc: new Date().toISOString(),
    installation,
    runner,
  });
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(evidenceRoot, "functional-evidence.json"), reportBytes, { flag: "wx" });
  return digest(reportBytes);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const [action, executable, evidenceRoot, startDigest] = process.argv.slice(2);
  const options = {
    executable,
    evidenceRoot,
    startDigest,
    expectedGitSha: process.env.LAUNDRY_WINDOWS_EXPECTED_SOURCE_SHA,
    profileId: process.env.LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE,
  };
  Promise.resolve()
    .then(async () => {
      requireValue(
        (action === "begin" && process.argv.length === 5) ||
          (action === "finish" && process.argv.length === 6),
        "ARGS_INVALID",
      );
      const result = await (action === "begin"
        ? beginFunctionalEvidence(options)
        : finishFunctionalEvidence(options));
      process.stdout.write(`${result}\n`);
    })
    .catch((error) => {
      const code = /^WINDOWS_[A-Z0-9_]+$/u.test(error.message ?? "")
        ? error.message
        : "WINDOWS_FUNCTIONAL_EVIDENCE_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
