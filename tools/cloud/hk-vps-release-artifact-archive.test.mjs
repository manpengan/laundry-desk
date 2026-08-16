import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ARTIFACT_PREFIX,
  archiveOrphanArtifact,
  archiveRetiredArtifact,
  archiveSupersededRollback,
  listArchivableArtifacts,
  planArtifactArchive,
  planOrphanArtifactArchive,
} from "./hk-vps-release-artifact-archive.mjs";
import { isDirectEntrypoint, parseArguments } from "./hk-vps-release-artifact-archive-run.mjs";

const FAILED = `${ARTIFACT_PREFIX}failed-${"a".repeat(40)}`;
const ROLLBACK = `${ARTIFACT_PREFIX}rollback-${"b".repeat(40)}-before-${"c".repeat(40)}`;
const ORPHAN = `${ARTIFACT_PREFIX}rollback-pre-abcdef0-20260809T112330Z`;

async function makeRoots() {
  // realpath normalises the macOS /var -> /private/var symlink so the module's realpath guard holds.
  const base = await realpath(await mkdtemp(join(tmpdir(), "laundry-artifact-archive-")));
  const optRoot = join(base, "opt");
  const archiveRoot = join(base, "archive");
  await mkdir(optRoot);
  await mkdir(archiveRoot);
  await chmod(optRoot, 0o755);
  await chmod(archiveRoot, 0o700);
  return { archiveRoot, base, optRoot };
}

async function makeArtifact(optRoot, name) {
  const path = join(optRoot, name);
  await mkdir(path);
  await chmod(path, 0o755);
  await mkdir(join(path, "nested"));
  await writeFile(join(path, "nested", "marker.txt"), "release artifact\n");
  return path;
}

function boundRecord(source, overrides = {}) {
  return {
    candidate_sha: "d".repeat(40),
    failed_path: source,
    outcome: "rolled_back",
    rollback_path: `${source}.other`,
    verification_evidence_authoritative: false,
    ...overrides,
  };
}

function dependenciesFor(roots, records, extra = {}) {
  const synced = [];
  return {
    dependencies: {
      archiveRoot: roots.archiveRoot,
      gid: process.getgid(),
      optRoot: roots.optRoot,
      records: async () => Object.freeze(records),
      syncDirectory: async (path) => void synced.push(path),
      uid: process.getuid(),
      ...extra,
    },
    synced,
  };
}

async function rejects(promise) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  assert.notEqual(error, null, "expected the archive guard to fail closed");
  assert.match(String(error.message ?? error), /CLOUD_RELEASE_ARTIFACT_ARCHIVE_INVALID/u);
}

test("archives a bound rolled-back artifact and proves the moved tree is the same object", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  const identity = await lstat(source);
  const { dependencies, synced } = dependenciesFor(roots, [boundRecord(source)]);

  const result = await archiveRetiredArtifact(FAILED, dependencies);

  assert.equal(result.target, join(roots.archiveRoot, FAILED.slice(ARTIFACT_PREFIX.length)));
  assert.equal(result.ino, identity.ino);
  // The artifact root, its one nested directory and the single file inside it.
  assert.equal(result.entries, 3);
  assert.deepEqual(result.candidates, ["d".repeat(40)]);
  assert.deepEqual(await readdir(roots.optRoot), []);
  assert.deepEqual(await readdir(result.target), ["nested"]);
  assert.deepEqual(synced, [roots.optRoot, roots.archiveRoot]);
});

test("archives a tree containing node_modules symlinks", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  // Every real deployment is a pnpm workspace; the tree this mover was written for holds 2,688
  // such links. Counting them as leaves is the whole point of this regression.
  await mkdir(join(source, "node_modules"));
  await symlink(join(source, "nested"), join(source, "node_modules", "linked-package"));
  await symlink("../../dangling-target", join(source, "node_modules", "dangling"));
  const { dependencies } = dependenciesFor(roots, [boundRecord(source)]);

  const result = await archiveRetiredArtifact(FAILED, dependencies);

  // root + nested + nested/marker.txt + node_modules + two links.
  assert.equal(result.entries, 6);
  assert.deepEqual(await readdir(roots.optRoot), []);
  assert.deepEqual((await readdir(join(result.target, "node_modules"))).sort(), [
    "dangling",
    "linked-package",
  ]);
});

test("refuses a name outside the retired artifact patterns", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  await makeArtifact(roots.optRoot, "laundry-desk.next-" + "a".repeat(40));
  const { dependencies } = dependenciesFor(roots, []);

  await rejects(planArtifactArchive("laundry-desk.next-" + "a".repeat(40), dependencies));
  await rejects(planArtifactArchive("laundry-desk", dependencies));
  await rejects(planArtifactArchive("../etc", dependencies));
});

test("refuses an artifact that no history record binds", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  await makeArtifact(roots.optRoot, FAILED);
  const { dependencies } = dependenciesFor(roots, []);

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("refuses the rollback tree of a committed release", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, ROLLBACK);
  const committed = boundRecord(source, {
    failed_path: `${source}.unused`,
    outcome: "committed",
    rollback_path: source,
    verification_evidence_authoritative: true,
  });
  const { dependencies } = dependenciesFor(roots, [committed]);

  await rejects(planArtifactArchive(ROLLBACK, dependencies));
  assert.deepEqual(await readdir(roots.optRoot), [ROLLBACK]);
});

test("refuses a rolled-back record that still carries authoritative evidence", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  const records = [boundRecord(source, { verification_evidence_authoritative: true })];
  const { dependencies } = dependenciesFor(roots, records);

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("refuses when any one of several bound records is not rolled back", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  const records = [boundRecord(source), boundRecord(source, { outcome: "committed" })];
  const { dependencies } = dependenciesFor(roots, records);

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("refuses when the archive target already exists", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  await mkdir(join(roots.archiveRoot, FAILED.slice(ARTIFACT_PREFIX.length)));
  const { dependencies } = dependenciesFor(roots, [boundRecord(source)]);

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("refuses a cross-device move because a rename would silently become a copy", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  const { dependencies } = dependenciesFor(roots, [boundRecord(source)], {
    lstat: async (path) => {
      const metadata = await lstat(path);
      if (path !== roots.archiveRoot) return metadata;
      return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, {
        dev: metadata.dev + 1,
      });
    },
  });

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("refuses a symlinked artifact and a symlinked archive root", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const real = await makeArtifact(roots.base, `${FAILED}.real`);
  await symlink(real, join(roots.optRoot, FAILED));
  const { dependencies } = dependenciesFor(roots, [boundRecord(join(roots.optRoot, FAILED))]);

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("refuses an archive root that is not root-only", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, FAILED);
  await chmod(roots.archiveRoot, 0o755);
  const { dependencies } = dependenciesFor(roots, [boundRecord(source)]);

  await rejects(planArtifactArchive(FAILED, dependencies));
});

test("lists only the artifacts history proves are archivable", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const archivable = await makeArtifact(roots.optRoot, FAILED);
  const live = await makeArtifact(roots.optRoot, ROLLBACK);
  await makeArtifact(roots.optRoot, "laundry-desk");
  const records = [
    boundRecord(archivable),
    boundRecord(live, {
      failed_path: `${live}.unused`,
      outcome: "committed",
      rollback_path: live,
      verification_evidence_authoritative: true,
    }),
  ];
  const { dependencies } = dependenciesFor(roots, records);

  assert.deepEqual(await listArchivableArtifacts(dependencies), [FAILED]);
});

test("the orphan path accepts a tree no history record references", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const live = await makeArtifact(roots.base, "live");
  const source = await makeArtifact(roots.optRoot, ORPHAN);
  // Bound to a different artifact, so the orphan under test stays unreferenced.
  const { dependencies } = dependenciesFor(roots, [boundRecord(join(roots.optRoot, FAILED))], {
    liveRoot: live,
    readReleaseMarker: async (root) => ({
      git_sha: root === live ? "1".repeat(40) : "2".repeat(40),
    }),
  });

  const result = await archiveOrphanArtifact(ORPHAN, dependencies);

  assert.equal(result.markerSha, "2".repeat(40));
  assert.equal(result.candidates, null);
  assert.deepEqual(await readdir(roots.optRoot), []);
  assert.equal(source.endsWith(ORPHAN), true);
});

test("the orphan path refuses a tree any history record still references", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const live = await makeArtifact(roots.base, "live");
  const source = await makeArtifact(roots.optRoot, ORPHAN);
  const marker = { git_sha: "2".repeat(40) };
  for (const overrides of [{ rollback_path: source }, { failed_path: source }]) {
    const { dependencies } = dependenciesFor(roots, [boundRecord(source, overrides)], {
      liveRoot: live,
      readReleaseMarker: async () => marker,
    });
    await rejects(planOrphanArtifactArchive(ORPHAN, dependencies));
  }
  assert.deepEqual(await readdir(roots.optRoot), [ORPHAN]);
});

test("the orphan path refuses a tree whose marker equals the live marker", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const live = await makeArtifact(roots.base, "live");
  await makeArtifact(roots.optRoot, ORPHAN);
  const { dependencies } = dependenciesFor(roots, [], {
    liveRoot: live,
    readReleaseMarker: async () => ({ git_sha: "3".repeat(40) }),
  });

  await rejects(planOrphanArtifactArchive(ORPHAN, dependencies));
});

test("the orphan path still refuses a name outside the retired patterns", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const live = await makeArtifact(roots.base, "live");
  const { dependencies } = dependenciesFor(roots, [], {
    liveRoot: live,
    readReleaseMarker: async () => ({ git_sha: "2".repeat(40) }),
  });

  await rejects(planOrphanArtifactArchive("laundry-desk.next-" + "a".repeat(40), dependencies));
});

const LIVE = "e".repeat(40);
const SUPERSEDED = "c".repeat(40);

function supersededRoots(roots, overrides = {}) {
  const source = join(roots.optRoot, ROLLBACK);
  const records = [
    {
      candidate_sha: SUPERSEDED,
      failed_path: `${source}.failed`,
      outcome: "committed",
      rollback_path: source,
      verification_evidence_authoritative: true,
      ...overrides,
    },
    {
      candidate_sha: LIVE,
      failed_path: null,
      outcome: "committed",
      rollback_path: `${source}.newer`,
      verification_evidence_authoritative: true,
    },
  ];
  return dependenciesFor(roots, records, {
    liveRoot: join(roots.base, "live"),
    readReleaseMarker: async (path) => ({
      git_sha: path === join(roots.base, "live") ? LIVE : SUPERSEDED,
    }),
  });
}

test("retires a superseded committed rollback tree and proves the same object moved", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  const source = await makeArtifact(roots.optRoot, ROLLBACK);
  const before = await lstat(source);
  const { dependencies } = supersededRoots(roots);

  const result = await archiveSupersededRollback(ROLLBACK, dependencies);

  assert.deepEqual(result.candidates, [SUPERSEDED]);
  assert.equal(result.markerSha, SUPERSEDED);
  assert.equal(result.ino, before.ino);
  assert.deepEqual(await readdir(roots.optRoot), []);
  assert.equal((await lstat(result.target)).ino, before.ino);
});

test("retiring a rollback tree refuses the live release and every weaker binding", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  for (const overrides of [
    // the live release keeps its own rollback tree
    { candidate_sha: LIVE },
    // only committed, authoritative records qualify
    { outcome: "rolled_back" },
    { verification_evidence_authoritative: false },
    // bound through failed_path, not rollback_path
    { failed_path: join(roots.optRoot, ROLLBACK), rollback_path: null },
  ]) {
    await makeArtifact(roots.optRoot, ROLLBACK);
    const { dependencies } = supersededRoots(roots, overrides);
    await rejects(archiveSupersededRollback(ROLLBACK, dependencies));
    await rm(join(roots.optRoot, ROLLBACK), { force: true, recursive: true });
  }
});

test("retiring a rollback tree refuses failed trees, orphans and multiple bindings", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));

  for (const name of [FAILED, ORPHAN]) {
    await makeArtifact(roots.optRoot, name);
    const { dependencies } = supersededRoots(roots);
    await rejects(archiveSupersededRollback(name, dependencies));
  }

  await makeArtifact(roots.optRoot, ROLLBACK);
  const source = join(roots.optRoot, ROLLBACK);
  const { dependencies } = dependenciesFor(
    roots,
    [
      {
        candidate_sha: SUPERSEDED,
        failed_path: null,
        outcome: "committed",
        rollback_path: source,
        verification_evidence_authoritative: true,
      },
      {
        candidate_sha: "f".repeat(40),
        failed_path: null,
        outcome: "rolled_back",
        rollback_path: source,
        verification_evidence_authoritative: false,
      },
    ],
    {
      liveRoot: join(roots.base, "live"),
      readReleaseMarker: async (path) => ({
        git_sha: path === join(roots.base, "live") ? LIVE : SUPERSEDED,
      }),
    },
  );
  await rejects(archiveSupersededRollback(ROLLBACK, dependencies));
});

test("retiring a rollback tree refuses when the live release has no committed record", async (t) => {
  const roots = await makeRoots();
  t.after(() => rm(roots.base, { force: true, recursive: true }));
  await makeArtifact(roots.optRoot, ROLLBACK);
  const source = join(roots.optRoot, ROLLBACK);
  const { dependencies } = dependenciesFor(
    roots,
    [
      {
        candidate_sha: SUPERSEDED,
        failed_path: null,
        outcome: "committed",
        rollback_path: source,
        verification_evidence_authoritative: true,
      },
    ],
    {
      liveRoot: join(roots.base, "live"),
      readReleaseMarker: async (path) => ({
        git_sha: path === join(roots.base, "live") ? LIVE : SUPERSEDED,
      }),
    },
  );
  await rejects(archiveSupersededRollback(ROLLBACK, dependencies));
});

test("host runner accepts only the four supported invocations", () => {
  assert.deepEqual(parseArguments(["--list"]), { action: "list" });
  assert.deepEqual(parseArguments(["--archive", FAILED]), { action: "archive", name: FAILED });

  assert.deepEqual(parseArguments(["--archive-orphan", ORPHAN]), {
    action: "archive-orphan",
    name: ORPHAN,
  });

  assert.deepEqual(parseArguments(["--retire-superseded-rollback", ROLLBACK]), {
    action: "retire-superseded-rollback",
    name: ROLLBACK,
  });

  for (const argv of [
    [],
    ["--list", FAILED],
    ["--archive"],
    ["--remove", FAILED],
    [FAILED],
    ["--archive-orphan"],
    ["--retire-superseded-rollback"],
  ]) {
    assert.throws(() => parseArguments(argv), /CLOUD_RELEASE_ARTIFACT_ARCHIVE_ARGS_INVALID/u);
  }
});

test("host runner only self-executes when it is the process entry point", () => {
  const moduleUrl = new URL("./hk-vps-release-artifact-archive-run.mjs", import.meta.url).href;

  assert.equal(isDirectEntrypoint(undefined, moduleUrl), false);
  assert.equal(isDirectEntrypoint("/some/other/script.mjs", moduleUrl), false);
});
