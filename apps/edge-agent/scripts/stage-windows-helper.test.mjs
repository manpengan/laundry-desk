import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  inspectCleanWindowsBuildSource,
  parseWindowsBuildProvenance,
  stageWindowsHelper,
} from "./stage-windows-helper.mjs";

const HELPER_FILE_NAME = "laundry-windows-helper.exe";
const PROVENANCE_FILE_NAME = "windows-build-provenance.json";
const SOURCE_GIT_SHA = "a".repeat(40);
const execFileAsync = promisify(execFile);

async function createFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-windows-helper-stage-")));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "output", "windows-helper");
  await Promise.all([mkdir(sourceRoot), mkdir(join(root, "output"))]);
  const helper = Buffer.from("fixture-windows-helper\n", "utf8");
  const digest = createHash("sha256").update(helper).digest("hex");
  await Promise.all([
    writeFile(join(sourceRoot, HELPER_FILE_NAME), helper),
    writeFile(join(sourceRoot, `${HELPER_FILE_NAME}.sha256`), `${digest}\n`, "ascii"),
  ]);
  return { digest, root, sourceRoot, targetRoot };
}

function gitRunner(root, { head = SOURCE_GIT_SHA, status = "" } = {}) {
  return async (_repositoryRoot, arguments_) => {
    if (arguments_.join(" ") === "rev-parse --show-toplevel") {
      return { stdout: `${root}\n` };
    }
    if (arguments_[0] === "status") return { stdout: status };
    if (arguments_.join(" ") === "rev-parse --verify HEAD^{commit}") {
      return { stdout: `${head}\n` };
    }
    throw new Error(`unexpected git arguments: ${arguments_.join(" ")}`);
  };
}

function stageOptions(fixture, options = {}) {
  return {
    expectedGitSha: SOURCE_GIT_SHA,
    repositoryRoot: fixture.root,
    runGit: gitRunner(fixture.root),
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.targetRoot,
    ...options,
  };
}

test("stages only a digest-bound Windows helper bundle", async (t) => {
  const fixture = await createFixture(t);

  const result = await stageWindowsHelper(stageOptions(fixture));

  assert.equal(result.digest, fixture.digest);
  assert.equal(result.sourceGitSha, SOURCE_GIT_SHA);
  assert.equal(result.targetRoot, fixture.targetRoot);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(fixture.targetRoot, HELPER_FILE_NAME)))
      .digest("hex"),
    fixture.digest,
  );
  assert.deepEqual(
    parseWindowsBuildProvenance(await readFile(join(fixture.targetRoot, PROVENANCE_FILE_NAME)), {
      expectedGitSha: SOURCE_GIT_SHA,
      expectedHelperDigest: fixture.digest,
    }),
    {
      assurance: "development_only",
      schema_version: 1,
      source_git_sha: SOURCE_GIT_SHA,
      source_tree: "clean",
      windows_helper_sha256: fixture.digest,
    },
  );
});

test("rejects a digest mismatch without replacing an existing staged helper", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.targetRoot);
  await writeFile(join(fixture.targetRoot, "sentinel"), "keep\n");
  await writeFile(join(fixture.sourceRoot, `${HELPER_FILE_NAME}.sha256`), `${"0".repeat(64)}\n`);

  await assert.rejects(
    () => stageWindowsHelper(stageOptions(fixture)),
    /STAGING_INTEGRITY_FAILED/u,
  );

  assert.equal(await readFile(join(fixture.targetRoot, "sentinel"), "utf8"), "keep\n");
});

test("rejects a multiply-linked helper source", async (t) => {
  const fixture = await createFixture(t);
  await link(join(fixture.sourceRoot, HELPER_FILE_NAME), join(fixture.root, "linked-helper.exe"));

  await assert.rejects(() => stageWindowsHelper(stageOptions(fixture)), /STAGING_FILE_INVALID/u);
});

test("rejects a dirty source tree and an unexpected source commit before staging", async (t) => {
  const dirty = await createFixture(t);
  await assert.rejects(
    () =>
      stageWindowsHelper(
        stageOptions(dirty, {
          runGit: gitRunner(dirty.root, { status: " M apps/edge-agent/src/main.ts\0" }),
        }),
      ),
    /WINDOWS_BUILD_SOURCE_NOT_CLEAN/u,
  );

  const stale = await createFixture(t);
  await assert.rejects(
    () =>
      stageWindowsHelper(
        stageOptions(stale, { runGit: gitRunner(stale.root, { head: "b".repeat(40) }) }),
      ),
    /WINDOWS_BUILD_SOURCE_SHA_MISMATCH/u,
  );
});

test("requires an explicit expected commit for a development-only Windows build", async (t) => {
  const fixture = await createFixture(t);

  await assert.rejects(
    () =>
      inspectCleanWindowsBuildSource({
        repositoryRoot: fixture.root,
        runGit: gitRunner(fixture.root),
      }),
    /WINDOWS_BUILD_SOURCE_EXPECTATION_INVALID/u,
  );
});

test("reads one real clean Git checkout and rejects tracked source drift", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-windows-source-git-")));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "source.txt"), "committed\n");
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "add", "source.txt"]);
  await execFileAsync("git", [
    "-c",
    "user.name=Windows Build Test",
    "-c",
    "user.email=windows-build-test@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "-C",
    root,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const head = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();

  assert.deepEqual(
    await inspectCleanWindowsBuildSource({ repositoryRoot: root, expectedGitSha: head }),
    { sourceGitSha: head, sourceTree: "clean" },
  );

  await writeFile(join(root, "source.txt"), "overlaid\n");
  await assert.rejects(
    () => inspectCleanWindowsBuildSource({ repositoryRoot: root, expectedGitSha: head }),
    /WINDOWS_BUILD_SOURCE_NOT_CLEAN/u,
  );
});
