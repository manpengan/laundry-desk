import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { completeFunctionalEvidence } from "../e2e/windows-functional-completion.mjs";
import { stageWindowsProfile } from "./windows-profile.mjs";
import { syncSpa } from "./sync-spa.mjs";
import {
  beginFunctionalEvidence,
  finishFunctionalEvidence,
  inspectFunctionalInstallation,
  inspectFunctionalRunner,
} from "./windows-functional-evidence.mjs";

const SOURCE = "a".repeat(40);
const OTHER_SOURCE = "b".repeat(40);
const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const RUNNER_SPEC = "apps/edge-agent/e2e/windows-functional.spec.ts";
const RUNNER_HELPER = "apps/edge-agent/scripts/windows-functional-evidence.mjs";
const CHECKER = "apps/edge-agent/dist/lib/integrity.js";

async function fixture(t, profileId = "generic") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-functional-evidence-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "installed", "resources");
  const repositoryRoot = join(root, "runner");
  const evidenceRoot = join(root, "evidence");
  const directories = [
    resources,
    repositoryRoot,
    evidenceRoot,
    join(resources, "windows-helper"),
    join(resources, "build-provenance"),
  ];
  for (const directory of directories) await mkdir(directory, { recursive: true });
  const staged = await stageWindowsProfile({
    profileId,
    targetRoot: join(root, "windows-profile"),
    expectedGitSha: SOURCE,
  });
  await cp(staged.targetRoot, join(resources, "distribution-profile"), { recursive: true });
  const executable = join(dirname(resources), staged.settings.executableFileName);
  await writeFile(executable, "installed executable fixture");
  await writeFile(join(resources, "app.asar"), "installed ASAR fixture");
  const helper = Buffer.from("installed native helper fixture");
  const helperPath = join(resources, "windows-helper", "laundry-windows-helper.exe");
  await writeFile(helperPath, helper);
  await writeFile(`${helperPath}.sha256`, `${hash(helper)}\n`);
  const provenancePath = join(resources, "build-provenance", "windows-source.json");
  await writeFile(
    provenancePath,
    JSON.stringify({
      schema_version: 1,
      assurance: "development_only",
      source_git_sha: SOURCE,
      source_tree: "clean",
      windows_helper_sha256: hash(helper),
    }),
  );
  const html = Buffer.from("<!doctype html><title>Installed fixture</title>");
  const spaSource = join(root, "spa-source");
  const spaRoot = join(resources, "spa");
  await mkdir(join(spaSource, "assets"), { recursive: true });
  await writeFile(join(spaSource, "index.html"), html);
  await writeFile(join(spaSource, "assets/app.js"), "document.title = 'Installed fixture';\n");
  // Use the actual packaging protocol: one top-level manifest points to a
  // content-addressed bundle containing only the listed resources.
  await syncSpa({ sourcePath: spaSource, targetPath: spaRoot });
  const manifest = await readFile(join(spaRoot, "manifest.json"));
  const bundleRoot = join(spaRoot, "bundles", hash(manifest));
  for (const file of [RUNNER_SPEC, RUNNER_HELPER]) {
    await mkdir(dirname(join(repositoryRoot, file)), { recursive: true });
    await writeFile(join(repositoryRoot, file), "// tracked test runner fixture\n");
  }
  const git = async (args) =>
    await execute("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", timeout: 15_000 });
  await git(["init", "--quiet"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Functional Evidence Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  for (const file of [CHECKER, "apps/edge-agent/dist/lib/mime.js"]) {
    await mkdir(dirname(join(repositoryRoot, file)), { recursive: true });
    await writeFile(join(repositoryRoot, file), "// actual compiled checker fixture\n");
  }
  return {
    executable,
    expectedGitSha: SOURCE,
    profileId,
    repositoryRoot,
    evidenceRoot,
    resources,
    provenancePath,
    bundleRoot,
    spaSource,
    git,
  };
}

async function observations(value) {
  await writeFile(
    join(value.evidenceRoot, "functional-observations.json"),
    JSON.stringify({
      status: "observed",
      navigation: ["receive"],
      renderer_errors: 0,
      server_failures: 0,
    }),
  );
}

test("finished evidence binds actual installation, independent Git runner and UTC interval", async (t) => {
  const value = await fixture(t, "hongfa");
  assert.deepEqual((await readdir(value.bundleRoot)).sort(), ["assets", "index.html"]);
  await assert.rejects(readFile(join(value.bundleRoot, "manifest.json")), { code: "ENOENT" });
  const startDigest = await beginFunctionalEvidence(value);
  await observations(value);
  const resultDigest = await finishFunctionalEvidence({ ...value, startDigest });
  const bytes = await readFile(join(value.evidenceRoot, "functional-evidence.json"));
  const result = JSON.parse(bytes);
  assert.equal(resultDigest, hash(bytes));
  assert.equal(result.status, "passed");
  assert.equal(result.installation.source_git_sha, SOURCE);
  assert.equal(result.installation.profile_id, "hongfa");
  assert.equal(result.installation.spa.entry_count, 2);
  assert.equal(
    result.installation.spa.bundle_sha256,
    hash(await readFile(join(value.resources, "spa/manifest.json"))),
  );
  assert.equal(result.installation.executable_sha256, hash(await readFile(value.executable)));
  assert.equal(
    result.installation.asar_sha256,
    hash(await readFile(join(value.resources, "app.asar"))),
  );
  assert.equal(
    result.runner.source_git_sha,
    (await value.git(["rev-parse", "HEAD"])).stdout.trim(),
  );
  assert.notEqual(result.runner.source_git_sha, SOURCE);
  assert.equal(result.runner.tracked_files_match_head, true);
  assert.equal(
    result.runner.tracked_files_sha256[RUNNER_SPEC],
    hash(await readFile(join(value.repositoryRoot, RUNNER_SPEC))),
  );
  assert.deepEqual(result.runtime, {
    status: "unverified",
    reason: "requires_separate_backend_identity_evidence",
  });
  assert.equal(
    result.runner.checker_artifacts_sha256[CHECKER],
    hash(await readFile(join(value.repositoryRoot, CHECKER))),
  );
  assert.equal(new Date(result.started_at_utc).toISOString(), result.started_at_utc);
  assert.ok(Date.parse(result.finished_at_utc) >= Date.parse(result.started_at_utc));
  assert.deepEqual(result.navigation, ["receive"]);
});

test("source SHA and profile expectations cannot replace installed provenance", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    inspectFunctionalInstallation({ ...value, expectedGitSha: OTHER_SOURCE }),
    /WINDOWS_BUILD_PROVENANCE_INVALID/u,
  );
  await assert.rejects(
    inspectFunctionalInstallation({ ...value, profileId: "hongfa" }),
    /WINDOWS_PROFILE/u,
  );
  await assert.rejects(
    inspectFunctionalInstallation({ ...value, profileId: "../generic" }),
    /EXPECTATION_INVALID/u,
  );
  await assert.rejects(
    inspectFunctionalInstallation({ ...value, expectedGitSha: undefined }),
    /EXPECTATION_INVALID/u,
  );
});

for (const part of ["exe", "asar", "spa"]) {
  test(`a running acceptance rejects changed ${part} bytes without publishing passed evidence`, async (t) => {
    const value = await fixture(t);
    const startDigest = await beginFunctionalEvidence(value);
    await observations(value);
    const path =
      part === "exe"
        ? value.executable
        : part === "asar"
          ? join(value.resources, "app.asar")
          : join(value.bundleRoot, "index.html");
    await writeFile(path, "changed after acceptance started");
    await assert.rejects(
      finishFunctionalEvidence({ ...value, startDigest }),
      /INSTALLATION_CHANGED|SPA_FILE_INVALID/u,
    );
    await assert.rejects(readFile(join(value.evidenceRoot, "functional-evidence.json")), {
      code: "ENOENT",
    });
  });
}

test("malformed and oversized provenance and noncanonical SPA metadata are refused", async (t) => {
  const value = await fixture(t);
  const original = await readFile(value.provenancePath);
  await writeFile(value.provenancePath, "{broken");
  await assert.rejects(inspectFunctionalInstallation(value), /WINDOWS_BUILD_PROVENANCE_INVALID/u);
  await writeFile(value.provenancePath, " ".repeat(1025));
  await assert.rejects(inspectFunctionalInstallation(value), /FILE_INVALID/u);
  await writeFile(value.provenancePath, original);
  const manifestPath = join(value.resources, "spa", "manifest.json");
  await writeFile(manifestPath, JSON.stringify(JSON.parse(await readFile(manifestPath, "utf8"))));
  await assert.rejects(inspectFunctionalInstallation(value), /SPA_MANIFEST_INVALID/u);
});

test("unexpected SPA files, directories and even a matching bundle manifest are refused", async (t) => {
  const value = await fixture(t);
  const extra = join(value.bundleRoot, "unexpected.txt");
  await writeFile(extra, "unlisted asset");
  await assert.rejects(inspectFunctionalInstallation(value), /SPA_TREE_INVALID/u);
  await rm(extra);
  const directory = join(value.bundleRoot, "unlisted-directory");
  await mkdir(directory);
  await assert.rejects(inspectFunctionalInstallation(value), /SPA_TREE_INVALID/u);
  await rm(directory, { recursive: true });
  await writeFile(
    join(value.bundleRoot, "manifest.json"),
    await readFile(join(value.resources, "spa/manifest.json")),
  );
  await assert.rejects(inspectFunctionalInstallation(value), /SPA_TREE_INVALID/u);
});

test("missing and hardlinked SPA assets cannot satisfy the active manifest", async (t) => {
  const value = await fixture(t);
  const asset = join(value.bundleRoot, "assets/app.js");
  const bytes = await readFile(asset);
  await rm(asset);
  await assert.rejects(inspectFunctionalInstallation(value), { code: "ENOENT" });
  await writeFile(asset, bytes);
  const alias = join(value.evidenceRoot, "shared.js");
  await link(asset, alias);
  await assert.rejects(inspectFunctionalInstallation(value), /FILE_INVALID/u);
});

test("a linked SPA resource directory cannot redirect verified assets", async (t) => {
  const value = await fixture(t);
  const assets = join(value.bundleRoot, "assets");
  const outside = join(value.evidenceRoot, "redirected-assets");
  await cp(assets, outside, { recursive: true });
  await rm(assets, { recursive: true });
  await symlink(outside, assets, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inspectFunctionalInstallation(value), /DIRECTORY_INVALID/u);
});

test("changing the canonical SPA pointer to another valid bundle cannot finish an active run", async (t) => {
  const value = await fixture(t);
  const startDigest = await beginFunctionalEvidence(value);
  await observations(value);
  await writeFile(join(value.spaSource, "assets/app.js"), "document.title = 'Changed bundle';\n");
  await syncSpa({ sourcePath: value.spaSource, targetPath: join(value.resources, "spa") });
  await assert.rejects(
    finishFunctionalEvidence({ ...value, startDigest }),
    /INSTALLATION_CHANGED/u,
  );
  await assert.rejects(readFile(join(value.evidenceRoot, "functional-evidence.json")), {
    code: "ENOENT",
  });
});

test("hardlinked provenance and a linked installation parent cannot be accepted", async (t) => {
  const value = await fixture(t);
  const alias = join(value.evidenceRoot, "shared.json");
  await link(value.provenancePath, alias);
  await assert.rejects(inspectFunctionalInstallation(value), /FILE_INVALID/u);
  await rm(alias);
  const linked = join(value.evidenceRoot, "redirected-installation");
  await symlink(
    dirname(value.executable),
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    inspectFunctionalInstallation({
      ...value,
      executable: join(linked, value.executable.split(/[\\/]/u).at(-1)),
    }),
    /DIRECTORY_INVALID/u,
  );
});

test("runner changes and tampered start evidence cannot produce passed output", async (t) => {
  const value = await fixture(t);
  const startDigest = await beginFunctionalEvidence(value);
  await observations(value);
  await writeFile(join(value.repositoryRoot, RUNNER_SPEC), "// changed runner\n");
  await assert.rejects(finishFunctionalEvidence({ ...value, startDigest }), /RUNNER_CHANGED/u);
  const runner = await inspectFunctionalRunner(value.repositoryRoot);
  assert.equal(runner.tracked_files_match_head, false);
  await writeFile(join(value.evidenceRoot, "functional-installation-start.json"), "{}");
  await assert.rejects(finishFunctionalEvidence({ ...value, startDigest }), /START_CHANGED/u);
});

test("unrelated documentation edits do not masquerade as a different test runner", async (t) => {
  const value = await fixture(t);
  const start = await inspectFunctionalRunner(value.repositoryRoot);
  await writeFile(join(value.repositoryRoot, "notes.md"), "unrelated release handoff\n");
  assert.deepEqual(await inspectFunctionalRunner(value.repositoryRoot), start);
});

test("changed compiled checker bytes reject completion independently of the Git HEAD", async (t) => {
  const value = await fixture(t);
  const startDigest = await beginFunctionalEvidence(value);
  await observations(value);
  await writeFile(join(value.repositoryRoot, CHECKER), "// changed compiled checker\n");
  const runner = await inspectFunctionalRunner(value.repositoryRoot);
  assert.equal(runner.tracked_files_match_head, true);
  await assert.rejects(finishFunctionalEvidence({ ...value, startDigest }), /RUNNER_CHANGED/u);
});

test("a reused evidence directory retains the prior result and is rejected before testing", async (t) => {
  const value = await fixture(t);
  const path = join(value.evidenceRoot, "functional-evidence.json");
  await writeFile(path, "previous receipt");
  await assert.rejects(beginFunctionalEvidence(value), /OUTPUT_EXISTS/u);
  assert.equal(await readFile(path, "utf8"), "previous receipt");
});

test("failed private-material cleanup cannot publish passing functional evidence", async (t) => {
  const value = await fixture(t);
  const startDigest = await beginFunctionalEvidence(value);
  await observations(value);
  const material = join(value.evidenceRoot, "private-material.fixture");
  await writeFile(material, "retained diagnostic fixture");
  const publish = async () => {
    await finishFunctionalEvidence({ ...value, startDigest });
  };
  await assert.rejects(
    completeFunctionalEvidence(async () => {
      throw new Error("cleanup.private-material failed");
    }, publish),
    /cleanup.private-material failed/u,
  );
  assert.equal(await readFile(material, "utf8"), "retained diagnostic fixture");
  await assert.rejects(readFile(join(value.evidenceRoot, "functional-evidence.json")), {
    code: "ENOENT",
  });
  await completeFunctionalEvidence(() => rm(material), publish);
  const report = JSON.parse(
    await readFile(join(value.evidenceRoot, "functional-evidence.json"), "utf8"),
  );
  assert.equal(report.status, "passed");
  await assert.rejects(readFile(material), { code: "ENOENT" });
});
