import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "..", "..");
const DEFAULT_SOURCE_ROOT = join(workspaceRoot, "packages", "platform-fs", "native", "windows");
const DEFAULT_TARGET_ROOT = join(packageRoot, "resources", "windows-helper");
const HELPER_FILE_NAME = "laundry-windows-helper.exe";
const DIGEST_FILE_NAME = `${HELPER_FILE_NAME}.sha256`;
const PROVENANCE_FILE_NAME = "windows-build-provenance.json";
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const execFileAsync = promisify(execFile);

async function assertDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("WINDOWS_HELPER_STAGING_DIRECTORY_INVALID");
  }
}

async function assertRegularUniqueFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("WINDOWS_HELPER_STAGING_FILE_INVALID");
  }
}

function parseDigest(bytes) {
  const digest = bytes.toString("ascii").trim();
  if (!SHA256.test(digest)) throw new Error("WINDOWS_HELPER_STAGING_DIGEST_INVALID");
  return digest;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function parseWindowsBuildProvenance(bytes, { expectedGitSha, expectedHelperDigest } = {}) {
  if (!GIT_SHA.test(expectedGitSha ?? "") || !SHA256.test(expectedHelperDigest ?? "")) {
    throw new Error("WINDOWS_BUILD_PROVENANCE_EXPECTATION_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("WINDOWS_BUILD_PROVENANCE_INVALID");
  }
  if (
    !exactKeys(parsed, [
      "assurance",
      "schema_version",
      "source_git_sha",
      "source_tree",
      "windows_helper_sha256",
    ]) ||
    parsed.schema_version !== 1 ||
    parsed.assurance !== "development_only" ||
    parsed.source_git_sha !== expectedGitSha ||
    parsed.source_tree !== "clean" ||
    parsed.windows_helper_sha256 !== expectedHelperDigest
  ) {
    throw new Error("WINDOWS_BUILD_PROVENANCE_INVALID");
  }
  return Object.freeze({ ...parsed });
}

function provenanceBytes(sourceGitSha, helperDigest) {
  return Buffer.from(
    `${JSON.stringify({
      assurance: "development_only",
      schema_version: 1,
      source_git_sha: sourceGitSha,
      source_tree: "clean",
      windows_helper_sha256: helperDigest,
    })}\n`,
    "utf8",
  );
}

async function defaultRunGit(repositoryRoot, arguments_) {
  return await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-C",
      repositoryRoot,
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function assertCleanStatus(status) {
  if (status === "") return;
  throw new Error("WINDOWS_BUILD_SOURCE_NOT_CLEAN");
}

export async function inspectCleanWindowsBuildSource({
  repositoryRoot = workspaceRoot,
  expectedGitSha,
  runGit = defaultRunGit,
} = {}) {
  if (!isAbsolute(repositoryRoot) || !GIT_SHA.test(expectedGitSha ?? "")) {
    throw new Error("WINDOWS_BUILD_SOURCE_EXPECTATION_INVALID");
  }
  const canonicalRoot = await realpath(repositoryRoot);
  const rootResult = await runGit(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  const reportedRoot = await realpath(rootResult.stdout.trim()).catch(() => null);
  if (reportedRoot !== canonicalRoot) throw new Error("WINDOWS_BUILD_SOURCE_ROOT_INVALID");

  const before = await runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const status = await runGit(canonicalRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=no",
  ]);
  const after = await runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const beforeSha = before.stdout.trim();
  const afterSha = after.stdout.trim();
  if (!GIT_SHA.test(beforeSha) || beforeSha !== expectedGitSha || afterSha !== expectedGitSha) {
    throw new Error("WINDOWS_BUILD_SOURCE_SHA_MISMATCH");
  }
  assertCleanStatus(status.stdout);
  return Object.freeze({ sourceGitSha: expectedGitSha, sourceTree: "clean" });
}

async function verifyHelperBundle(root) {
  const helperPath = join(root, HELPER_FILE_NAME);
  const digestPath = join(root, DIGEST_FILE_NAME);
  await Promise.all([
    assertDirectory(root),
    assertRegularUniqueFile(helperPath),
    assertRegularUniqueFile(digestPath),
  ]);
  const [helper, digestBytes] = await Promise.all([readFile(helperPath), readFile(digestPath)]);
  const digest = parseDigest(digestBytes);
  if (createHash("sha256").update(helper).digest("hex") !== digest) {
    throw new Error("WINDOWS_HELPER_STAGING_INTEGRITY_FAILED");
  }
  return digest;
}

export async function stageWindowsHelper({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot = DEFAULT_TARGET_ROOT,
  repositoryRoot = workspaceRoot,
  expectedGitSha,
  runGit = defaultRunGit,
} = {}) {
  if (
    !isAbsolute(sourceRoot) ||
    !isAbsolute(targetRoot) ||
    basename(targetRoot) !== "windows-helper"
  ) {
    throw new Error("WINDOWS_HELPER_STAGING_PATH_INVALID");
  }
  await assertDirectory(dirname(targetRoot));
  const source = await inspectCleanWindowsBuildSource({
    repositoryRoot,
    expectedGitSha,
    runGit,
  });
  const sourceDigest = await verifyHelperBundle(sourceRoot);
  const temporaryRoot = `${targetRoot}.${process.pid}.tmp`;
  await rm(temporaryRoot, { force: true, recursive: true });
  await mkdir(temporaryRoot);
  try {
    await Promise.all([
      copyFile(join(sourceRoot, HELPER_FILE_NAME), join(temporaryRoot, HELPER_FILE_NAME)),
      copyFile(join(sourceRoot, DIGEST_FILE_NAME), join(temporaryRoot, DIGEST_FILE_NAME)),
      writeFile(
        join(temporaryRoot, PROVENANCE_FILE_NAME),
        provenanceBytes(source.sourceGitSha, sourceDigest),
        { flag: "wx" },
      ),
    ]);
    const stagedDigest = await verifyHelperBundle(temporaryRoot);
    if (stagedDigest !== sourceDigest) {
      throw new Error("WINDOWS_HELPER_STAGING_INTEGRITY_FAILED");
    }
    const entries = (await readdir(temporaryRoot)).sort();
    if (
      JSON.stringify(entries) !==
      JSON.stringify([DIGEST_FILE_NAME, HELPER_FILE_NAME, PROVENANCE_FILE_NAME].sort())
    ) {
      throw new Error("WINDOWS_HELPER_STAGING_CONTENT_INVALID");
    }
    parseWindowsBuildProvenance(await readFile(join(temporaryRoot, PROVENANCE_FILE_NAME)), {
      expectedGitSha: source.sourceGitSha,
      expectedHelperDigest: stagedDigest,
    });
    await rm(targetRoot, { force: true, recursive: true });
    await rename(temporaryRoot, targetRoot);
    return Object.freeze({
      digest: stagedDigest,
      sourceGitSha: source.sourceGitSha,
      targetRoot,
    });
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  if (process.platform !== "win32") {
    process.stderr.write("WINDOWS_HELPER_STAGING_REQUIRES_WINDOWS\n");
    process.exitCode = 1;
  } else {
    stageWindowsHelper({ expectedGitSha: process.env.LAUNDRY_WINDOWS_BUILD_GIT_SHA })
      .then(({ digest, sourceGitSha }) =>
        process.stdout.write(
          `WINDOWS_HELPER_STAGING_OK source_git_sha=${sourceGitSha} helper_sha256=${digest}\n`,
        ),
      )
      .catch(() => {
        process.stderr.write("WINDOWS_HELPER_STAGING_FAILED\n");
        process.exitCode = 1;
      });
  }
}
