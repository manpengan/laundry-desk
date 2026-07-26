import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import { checkSpa, syncSpa } from "./sync-spa.mjs";

const execFileAsync = promisify(execFile);
const MANIFEST_FILE = "manifest.json";
const BUNDLES_DIRECTORY = "bundles";
const SHA256 = /^[0-9a-f]{64}$/u;
const temporaryDirectories = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createFixture() {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "laundry-spa-sync-")));
  temporaryDirectories.push(rootPath);
  const sourcePath = join(rootPath, "web", "dist-spa");
  const targetPath = join(rootPath, "edge-agent", "resources", "spa");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(targetPath, { recursive: true });
  return Object.freeze({ rootPath, sourcePath, targetPath });
}

async function writeSourceBundle(sourcePath, revision = "a") {
  await rm(sourcePath, { force: true, recursive: true });
  await mkdir(join(sourcePath, "assets"), { recursive: true });
  const files = Object.freeze({
    "index.html": `<!doctype html><script type="module" src="./assets/app.js"></script><!--${revision}-->\n`,
    "assets/app.js": `console.log('laundry-${revision}');\n`,
    "assets/theme.css": `:root { color-scheme: light; --revision: ${revision}; }\n`,
  });
  // Deliberately create files out of manifest order.
  await writeFile(join(sourcePath, "index.html"), files["index.html"]);
  await writeFile(join(sourcePath, "assets", "theme.css"), files["assets/theme.css"]);
  await writeFile(join(sourcePath, "assets", "app.js"), files["assets/app.js"]);
  await writeFile(join(sourcePath, MANIFEST_FILE), '{"ignored":"source manifest"}\n');
  return files;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function mimeForFixtureKey(key) {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (key.endsWith(".css")) return "text/css; charset=utf-8";
  throw new Error(`unexpected fixture MIME: ${key}`);
}

function canonicalManifestForFiles(files) {
  const entries = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((key) => [
        key,
        {
          sha256: sha256(files[key]),
          mime: mimeForFixtureKey(key),
          bytes: Buffer.byteLength(files[key]),
        },
      ]),
  );
  return { version: 1, entries };
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeLegacyTarget(targetPath) {
  await rm(targetPath, { force: true, recursive: true });
  await mkdir(join(targetPath, "assets"), { recursive: true });
  const files = {
    "index.html": "<!doctype html><script src='./app.js'></script>\n",
    "app.js": "console.log('legacy');\n",
    "assets/legacy.css": "body { color: #111; }\n",
  };
  await writeFile(join(targetPath, "index.html"), files["index.html"]);
  await writeFile(join(targetPath, "app.js"), files["app.js"]);
  await writeFile(join(targetPath, "assets", "legacy.css"), files["assets/legacy.css"]);
  await writeFile(
    join(targetPath, MANIFEST_FILE),
    serializeManifest(canonicalManifestForFiles(files)),
  );
}

async function listTree(rootPath, relativePath = "") {
  const directoryPath = relativePath === "" ? rootPath : join(rootPath, relativePath);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const entryPath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    paths.push(entryPath);
    if (entry.isDirectory()) {
      paths.push(...(await listTree(rootPath, entryPath)));
    }
  }
  return paths.sort();
}

function metadataKind(metadata) {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  if (metadata.isSymbolicLink()) return "symlink";
  return "other";
}

async function snapshotTree(rootPath) {
  const paths = await listTree(rootPath);
  const snapshot = [];
  for (const path of paths) {
    const filePath = join(rootPath, ...path.split("/"));
    const metadata = await lstat(filePath, { bigint: true });
    snapshot.push(
      Object.freeze({
        path,
        kind: metadataKind(metadata),
        mode: metadata.mode,
        mtimeNs: metadata.mtimeNs,
        content: metadata.isFile() ? (await readFile(filePath)).toString("base64") : null,
      }),
    );
  }
  return snapshot;
}

async function readPointer(targetPath) {
  const rawManifest = await readFile(join(targetPath, MANIFEST_FILE), "utf8");
  const manifest = JSON.parse(rawManifest);
  const bundleId = sha256(rawManifest);
  return Object.freeze({
    rawManifest,
    manifest,
    bundleId,
    bundlePath: join(targetPath, BUNDLES_DIRECTORY, bundleId),
  });
}

async function assertPointerComplete(targetPath, expectedFiles) {
  const pointer = await readPointer(targetPath);
  assert.match(pointer.bundleId, SHA256);
  assert.equal(pointer.rawManifest, serializeManifest(pointer.manifest));
  assert.deepEqual(pointer.manifest, canonicalManifestForFiles(expectedFiles));
  assert.deepEqual(await listTree(pointer.bundlePath), [
    "assets",
    "assets/app.js",
    "assets/theme.css",
    "index.html",
  ]);
  for (const [key, content] of Object.entries(expectedFiles)) {
    assert.equal(await readFile(join(pointer.bundlePath, ...key.split("/")), "utf8"), content);
  }
  return pointer;
}

async function assertRetainedBundles(targetPath, bundleIds) {
  const sortedIds = [...bundleIds].sort();
  assert.deepEqual((await readdir(join(targetPath, BUNDLES_DIRECTORY))).sort(), sortedIds);
  const expectedTree = [BUNDLES_DIRECTORY, MANIFEST_FILE];
  for (const bundleId of sortedIds) {
    expectedTree.push(
      `${BUNDLES_DIRECTORY}/${bundleId}`,
      `${BUNDLES_DIRECTORY}/${bundleId}/assets`,
      `${BUNDLES_DIRECTORY}/${bundleId}/assets/app.js`,
      `${BUNDLES_DIRECTORY}/${bundleId}/assets/theme.css`,
      `${BUNDLES_DIRECTORY}/${bundleId}/index.html`,
    );
  }
  assert.deepEqual(await listTree(targetPath), expectedTree.sort());
}

function isBundleInstall(targetPath, destinationPath) {
  return (
    dirname(destinationPath) === join(targetPath, BUNDLES_DIRECTORY) &&
    SHA256.test(basename(destinationPath))
  );
}

async function runPublisherUntilSigkill(fixture, hookName) {
  const moduleUrl = new URL("./sync-spa.mjs", import.meta.url).href;
  const source = `
    import { syncSpa } from ${JSON.stringify(moduleUrl)};
    await syncSpa(
      ${JSON.stringify({
        sourcePath: fixture.sourcePath,
        targetPath: fixture.targetPath,
      })},
      { ${hookName}() { process.kill(process.pid, "SIGKILL"); } },
    );
  `;
  await assert.rejects(
    () => execFileAsync(process.execPath, ["--input-type=module", "--eval", source]),
    (error) => error instanceof Error && "signal" in error && error.signal === "SIGKILL",
  );
}

test("syncSpa creates a canonical pointer to one immutable content-addressed bundle", async () => {
  const { sourcePath, targetPath } = await createFixture();
  const sourceFiles = await writeSourceBundle(sourcePath);

  assert.deepEqual(await syncSpa({ sourcePath, targetPath }), { entries: 3 });

  const pointer = await assertPointerComplete(targetPath, sourceFiles);
  await assertRetainedBundles(targetPath, [pointer.bundleId]);
  assert.equal(
    await readFile(join(sourcePath, MANIFEST_FILE), "utf8"),
    '{"ignored":"source manifest"}\n',
  );
});

test("syncSpa switches A to B only through one root manifest rename", async () => {
  const { sourcePath, targetPath } = await createFixture();
  const sourceA = await writeSourceBundle(sourcePath, "a");
  await syncSpa({ sourcePath, targetPath });
  const pointerA = await assertPointerComplete(targetPath, sourceA);
  const sourceB = await writeSourceBundle(sourcePath, "b");
  const observations = [];

  await syncSpa(
    { sourcePath, targetPath },
    {
      async renamePath(source, destination) {
        const before = await readFile(join(targetPath, MANIFEST_FILE), "utf8");
        await rename(source, destination);
        const after = await readFile(join(targetPath, MANIFEST_FILE), "utf8");
        observations.push({ source, destination, before, after });
      },
    },
  );

  const pointerB = await assertPointerComplete(targetPath, sourceB);
  assert.notEqual(pointerB.bundleId, pointerA.bundleId);
  assert.equal(
    observations.filter(({ destination }) => destination === join(targetPath, MANIFEST_FILE))
      .length,
    1,
  );
  assert.equal(
    observations.filter(({ destination }) => isBundleInstall(targetPath, destination)).length,
    1,
  );
  for (const observation of observations) {
    assert.notEqual(observation.source, targetPath);
    assert.notEqual(observation.destination, targetPath);
    if (observation.destination !== join(targetPath, MANIFEST_FILE)) {
      assert.equal(observation.before, pointerA.rawManifest);
      assert.equal(observation.after, pointerA.rawManifest);
    }
  }
  const commit = observations.find(
    ({ destination }) => destination === join(targetPath, MANIFEST_FILE),
  );
  assert.equal(commit.before, pointerA.rawManifest);
  assert.equal(commit.after, pointerB.rawManifest);
  await assertRetainedBundles(targetPath, [pointerA.bundleId, pointerB.bundleId]);
  assert.deepEqual(await checkSpa({ sourcePath, targetPath }), { entries: 3 });
});

test("syncSpa makes the bundle durable before committing the manifest pointer", async () => {
  const { sourcePath, targetPath } = await createFixture();
  await writeSourceBundle(sourcePath);
  const events = [];

  await syncSpa(
    { sourcePath, targetPath },
    {
      async afterFsync(event) {
        events.push({ type: "fsync", ...event });
      },
      async beforeManifestCommit() {
        events.push({ type: "before-manifest-commit" });
      },
      async renamePath(source, destination) {
        events.push({ type: "rename", source, destination });
        await rename(source, destination);
      },
    },
  );

  const bundleRenameIndex = events.findIndex(
    (event) => event.type === "rename" && isBundleInstall(targetPath, event.destination),
  );
  const bundlesFsyncIndex = events.findIndex(
    (event, index) =>
      index > bundleRenameIndex &&
      event.type === "fsync" &&
      event.kind === "directory" &&
      event.path === join(targetPath, BUNDLES_DIRECTORY),
  );
  const manifestFileFsyncIndex = events.findIndex(
    (event) =>
      event.type === "fsync" &&
      event.kind === "file" &&
      dirname(event.path) === targetPath &&
      basename(event.path).startsWith(`.${MANIFEST_FILE}.tmp-`),
  );
  const beforeCommitIndex = events.findIndex((event) => event.type === "before-manifest-commit");
  const manifestRenameIndex = events.findIndex(
    (event) => event.type === "rename" && event.destination === join(targetPath, MANIFEST_FILE),
  );
  const rootFsyncIndex = events.findIndex(
    (event, index) =>
      index > manifestRenameIndex &&
      event.type === "fsync" &&
      event.kind === "directory" &&
      event.path === targetPath,
  );

  assert.ok(bundleRenameIndex > 0);
  assert.ok(
    events
      .slice(0, bundleRenameIndex)
      .some((event) => event.type === "fsync" && event.kind === "file"),
  );
  assert.ok(bundlesFsyncIndex > bundleRenameIndex);
  assert.ok(manifestFileFsyncIndex > bundlesFsyncIndex);
  assert.ok(beforeCommitIndex > manifestFileFsyncIndex);
  assert.ok(manifestRenameIndex > beforeCommitIndex);
  assert.ok(rootFsyncIndex > manifestRenameIndex);
});

const preCommitFailures = [
  {
    name: "final bundle rename throws",
    dependencies(targetPath) {
      return {
        async renamePath(source, destination) {
          if (isBundleInstall(targetPath, destination)) {
            throw new Error("injected bundle rename failure");
          }
          await rename(source, destination);
        },
      };
    },
  },
  {
    name: "the process crashes before manifest commit",
    dependencies() {
      return {
        async beforeManifestCommit() {
          throw new Error("injected pre-commit crash");
        },
      };
    },
  },
  {
    name: "the manifest rename throws",
    dependencies(targetPath) {
      return {
        async renamePath(source, destination) {
          if (destination === join(targetPath, MANIFEST_FILE)) {
            throw new Error("injected manifest rename failure");
          }
          await rename(source, destination);
        },
      };
    },
  },
];

for (const failure of preCommitFailures) {
  test(`syncSpa leaves the complete A pointer readable when ${failure.name}`, async () => {
    const { sourcePath, targetPath } = await createFixture();
    const sourceA = await writeSourceBundle(sourcePath, "a");
    await syncSpa({ sourcePath, targetPath });
    const pointerA = await assertPointerComplete(targetPath, sourceA);
    const bundleBefore = await snapshotTree(pointerA.bundlePath);
    await writeSourceBundle(sourcePath, "b");

    await assert.rejects(
      () => syncSpa({ sourcePath, targetPath }, failure.dependencies(targetPath)),
      /injected/u,
    );

    assert.equal(await readFile(join(targetPath, MANIFEST_FILE), "utf8"), pointerA.rawManifest);
    assert.deepEqual(await snapshotTree(pointerA.bundlePath), bundleBefore);
    await assertPointerComplete(targetPath, sourceA);
  });
}

test("a failed first publish leaves a recoverable managed staging shape", async () => {
  const fixture = await createFixture();
  const source = await writeSourceBundle(fixture.sourcePath, "first");

  await assert.rejects(
    () =>
      syncSpa(fixture, {
        async beforeManifestCommit() {
          throw new Error("injected first publish failure");
        },
      }),
    /injected first publish failure/u,
  );

  await syncSpa(fixture);
  await assertPointerComplete(fixture.targetPath, source);
  assert.deepEqual(await checkSpa(fixture), { entries: 3 });
});

test(
  "a first-publish SIGKILL recovers after the stale publication lock expires",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    const source = await writeSourceBundle(fixture.sourcePath, "first");

    await runPublisherUntilSigkill(fixture, "beforeManifestCommit");
    await delay(3_000);
    await syncSpa(fixture, { lockStaleMs: 2_000 });

    await assertPointerComplete(fixture.targetPath, source);
    assert.deepEqual(await checkSpa(fixture), { entries: 3 });
  },
);

test(
  "a real SIGKILL before pointer commit leaves the complete previous version readable",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    const sourceA = await writeSourceBundle(fixture.sourcePath, "a");
    await syncSpa(fixture);
    const pointerA = await assertPointerComplete(fixture.targetPath, sourceA);
    const sourceB = await writeSourceBundle(fixture.sourcePath, "b");

    await runPublisherUntilSigkill(fixture, "beforeManifestCommit");

    assert.equal((await readPointer(fixture.targetPath)).bundleId, pointerA.bundleId);
    await assertPointerComplete(fixture.targetPath, sourceA);
    await delay(3_000);
    await syncSpa(fixture, { lockStaleMs: 2_000 });
    await assertPointerComplete(fixture.targetPath, sourceB);
  },
);

test(
  "a third-version SIGKILL after pointer rename keeps valid history recoverable",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    await writeSourceBundle(fixture.sourcePath, "a");
    await syncSpa(fixture);
    const pointerA = await readPointer(fixture.targetPath);
    await writeSourceBundle(fixture.sourcePath, "b");
    await syncSpa(fixture);
    const pointerB = await readPointer(fixture.targetPath);
    const sourceC = await writeSourceBundle(fixture.sourcePath, "c");

    await runPublisherUntilSigkill(fixture, "afterManifestRename");

    const pointerC = await assertPointerComplete(fixture.targetPath, sourceC);
    await delay(3_000);
    await syncSpa(fixture, { lockStaleMs: 2_000 });
    await assertPointerComplete(fixture.targetPath, sourceC);
    await assertRetainedBundles(fixture.targetPath, [
      pointerA.bundleId,
      pointerB.bundleId,
      pointerC.bundleId,
    ]);
    assert.deepEqual(await checkSpa(fixture), { entries: 3 });
  },
);

test("syncSpa migrates the legacy root layout only after the manifest commit", async () => {
  const { sourcePath, targetPath } = await createFixture();
  const sourceFiles = await writeSourceBundle(sourcePath, "new");
  await writeLegacyTarget(targetPath);
  const legacyManifest = await readFile(join(targetPath, MANIFEST_FILE), "utf8");
  const legacyIndex = await readFile(join(targetPath, "index.html"), "utf8");
  const legacyScript = await readFile(join(targetPath, "app.js"), "utf8");

  await assert.rejects(
    () =>
      syncSpa(
        { sourcePath, targetPath },
        {
          async beforeManifestCommit() {
            throw new Error("injected migration crash");
          },
        },
      ),
    /injected migration crash/u,
  );
  assert.equal(await readFile(join(targetPath, MANIFEST_FILE), "utf8"), legacyManifest);
  assert.equal(await readFile(join(targetPath, "index.html"), "utf8"), legacyIndex);
  assert.equal(await readFile(join(targetPath, "app.js"), "utf8"), legacyScript);

  await syncSpa({ sourcePath, targetPath });
  const pointer = await assertPointerComplete(targetPath, sourceFiles);
  await assertRetainedBundles(targetPath, [pointer.bundleId]);
});

test("checkSpa is read-only and accepts only an exact source and active bundle match", async () => {
  const { sourcePath, targetPath } = await createFixture();
  await writeSourceBundle(sourcePath);
  await syncSpa({ sourcePath, targetPath });
  const before = await snapshotTree(targetPath);

  assert.deepEqual(await checkSpa({ sourcePath, targetPath }), { entries: 3 });
  assert.deepEqual(await snapshotTree(targetPath), before);
});

test("checkSpa detects changed, missing, extra, manifest, and source drift without repairing", async () => {
  const changed = await createFixture();
  await writeSourceBundle(changed.sourcePath);
  await syncSpa(changed);
  const changedPointer = await readPointer(changed.targetPath);
  const changedPath = join(changedPointer.bundlePath, "assets", "app.js");
  await writeFile(changedPath, "tampered\n");
  await assert.rejects(() => checkSpa(changed), /SPA drift/u);
  assert.equal(await readFile(changedPath, "utf8"), "tampered\n");

  const missing = await createFixture();
  await writeSourceBundle(missing.sourcePath);
  await syncSpa(missing);
  const missingPointer = await readPointer(missing.targetPath);
  await rm(join(missingPointer.bundlePath, "assets", "theme.css"));
  await assert.rejects(() => checkSpa(missing), /SPA drift/u);

  const extra = await createFixture();
  await writeSourceBundle(extra.sourcePath);
  await syncSpa(extra);
  const extraPointer = await readPointer(extra.targetPath);
  const extraPath = join(extraPointer.bundlePath, "assets", "extra.css");
  await writeFile(extraPath, "body {}\n");
  await assert.rejects(() => checkSpa(extra), /SPA drift/u);
  assert.equal(await readFile(extraPath, "utf8"), "body {}\n");

  const manifest = await createFixture();
  await writeSourceBundle(manifest.sourcePath);
  await syncSpa(manifest);
  const manifestPath = join(manifest.targetPath, MANIFEST_FILE);
  const manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify({ ...manifestValue, extra: true }, null, 2)}\n`);
  await assert.rejects(() => checkSpa(manifest), /SPA manifest/u);

  const source = await createFixture();
  await writeSourceBundle(source.sourcePath);
  await syncSpa(source);
  const targetBefore = await snapshotTree(source.targetPath);
  await writeSourceBundle(source.sourcePath, "changed");
  await assert.rejects(() => checkSpa(source), /SPA drift/u);
  assert.deepEqual(await snapshotTree(source.targetPath), targetBefore);
});

test("checkSpa rejects active symlinks and unknown MIME without changing the target", async () => {
  const linked = await createFixture();
  await writeSourceBundle(linked.sourcePath);
  await syncSpa(linked);
  const linkedPointer = await readPointer(linked.targetPath);
  const externalScript = join(linked.rootPath, "external.js");
  await writeFile(externalScript, "console.log('external');\n");
  const linkedPath = join(linkedPointer.bundlePath, "assets", "app.js");
  await rm(linkedPath);
  await symlink(externalScript, linkedPath);
  const linkedBefore = await snapshotTree(linked.targetPath);
  await assert.rejects(() => checkSpa(linked), /symbolic link/u);
  assert.deepEqual(await snapshotTree(linked.targetPath), linkedBefore);

  const unknown = await createFixture();
  await writeSourceBundle(unknown.sourcePath);
  await syncSpa(unknown);
  const unknownPointer = await readPointer(unknown.targetPath);
  await writeFile(join(unknownPointer.bundlePath, "assets", "payload.bin"), "unknown\n");
  const unknownBefore = await snapshotTree(unknown.targetPath);
  await assert.rejects(() => checkSpa(unknown), /unknown MIME/u);
  assert.deepEqual(await snapshotTree(unknown.targetPath), unknownBefore);
});

test(
  "checkSpa rejects non-regular active entries without changing the target",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    await writeSourceBundle(fixture.sourcePath);
    await syncSpa(fixture);
    const pointer = await readPointer(fixture.targetPath);
    await execFileAsync("mkfifo", [join(pointer.bundlePath, "assets", "stream.css")]);
    const before = await snapshotTree(fixture.targetPath);

    await assert.rejects(() => checkSpa(fixture), /regular file/u);
    assert.deepEqual(await snapshotTree(fixture.targetPath), before);
  },
);

test("checkSpa rejects stale bundles and legacy root assets while syncSpa cleans them", async () => {
  const fixture = await createFixture();
  await writeSourceBundle(fixture.sourcePath, "a");
  await syncSpa(fixture);
  const pointerA = await readPointer(fixture.targetPath);
  const staleId = "f".repeat(64);
  const stalePath = join(fixture.targetPath, BUNDLES_DIRECTORY, staleId);
  await mkdir(stalePath);
  await writeFile(join(stalePath, "index.html"), "stale\n");
  await writeFile(join(fixture.targetPath, "index.html"), "legacy\n");
  const before = await snapshotTree(fixture.targetPath);

  await assert.rejects(() => checkSpa(fixture), /stale bundle|root asset/u);
  assert.deepEqual(await snapshotTree(fixture.targetPath), before);

  const sourceB = await writeSourceBundle(fixture.sourcePath, "b");
  await syncSpa(fixture);
  const pointerB = await assertPointerComplete(fixture.targetPath, sourceB);
  await assertRetainedBundles(fixture.targetPath, [pointerA.bundleId, pointerB.bundleId]);
});

test("syncSpa retains valid immutable bundle history until reader-aware pruning exists", async () => {
  const fixture = await createFixture();
  await writeSourceBundle(fixture.sourcePath, "a");
  await syncSpa(fixture);
  const pointerA = await readPointer(fixture.targetPath);
  await writeSourceBundle(fixture.sourcePath, "b");
  await syncSpa(fixture);
  const pointerB = await readPointer(fixture.targetPath);
  await writeSourceBundle(fixture.sourcePath, "c");
  await syncSpa(fixture);
  const pointerC = await readPointer(fixture.targetPath);

  assert.notEqual(pointerA.bundleId, pointerB.bundleId);
  assert.notEqual(pointerB.bundleId, pointerC.bundleId);
  await assertRetainedBundles(fixture.targetPath, [
    pointerA.bundleId,
    pointerB.bundleId,
    pointerC.bundleId,
  ]);
  await syncSpa(fixture);
  await assertRetainedBundles(fixture.targetPath, [
    pointerA.bundleId,
    pointerB.bundleId,
    pointerC.bundleId,
  ]);
  assert.deepEqual(await checkSpa(fixture), { entries: 3 });
});

test("syncSpa serializes concurrent publishers with one cross-process lock", async () => {
  const fixture = await createFixture();
  await writeSourceBundle(fixture.sourcePath);
  let releaseFirst;
  const firstMayContinue = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let reportFirstLocked;
  const firstLocked = new Promise((resolve) => {
    reportFirstLocked = resolve;
  });

  const first = syncSpa(fixture, {
    async afterLockAcquired() {
      reportFirstLocked();
      await firstMayContinue;
    },
  });
  await firstLocked;
  await assert.rejects(() => syncSpa(fixture), /sync lock is already held/u);
  releaseFirst();
  await first;
  assert.deepEqual(await checkSpa(fixture), { entries: 3 });
});

test("syncSpa releases its publication lock when setup fails after acquisition", async () => {
  const fixture = await createFixture();
  await writeSourceBundle(fixture.sourcePath);

  await assert.rejects(
    () =>
      syncSpa(fixture, {
        async afterLockAcquired() {
          throw new Error("injected lock setup failure");
        },
      }),
    /injected lock setup failure/u,
  );

  await syncSpa(fixture);
  assert.deepEqual(await checkSpa(fixture), { entries: 3 });
});

test("syncSpa never repairs or replaces an existing mismatched candidate bundle", async () => {
  const fixture = await createFixture();
  const sourceA = await writeSourceBundle(fixture.sourcePath, "a");
  await syncSpa(fixture);
  const pointerA = await assertPointerComplete(fixture.targetPath, sourceA);

  const sourceB = await writeSourceBundle(fixture.sourcePath, "b");
  const candidateId = sha256(serializeManifest(canonicalManifestForFiles(sourceB)));
  const candidatePath = join(fixture.targetPath, BUNDLES_DIRECTORY, candidateId);
  await mkdir(candidatePath);
  await writeFile(join(candidatePath, "index.html"), "partial candidate\n");

  await assert.rejects(() => syncSpa(fixture), /SPA drift|missing/u);
  assert.equal((await readPointer(fixture.targetPath)).bundleId, pointerA.bundleId);
  assert.equal(await readFile(join(candidatePath, "index.html"), "utf8"), "partial candidate\n");
});

test("syncSpa rejects unsafe source entries while preserving the active version", async () => {
  const symlinkFixture = await createFixture();
  const sourceA = await writeSourceBundle(symlinkFixture.sourcePath, "a");
  await syncSpa(symlinkFixture);
  const targetBefore = await snapshotTree(symlinkFixture.targetPath);
  const externalScript = join(symlinkFixture.rootPath, "external.js");
  await writeFile(externalScript, "console.log('external');\n");
  await symlink(externalScript, join(symlinkFixture.sourcePath, "assets", "linked.js"));

  await assert.rejects(() => syncSpa(symlinkFixture), /symbolic link/u);
  assert.deepEqual(await snapshotTree(symlinkFixture.targetPath), targetBefore);
  await assertPointerComplete(symlinkFixture.targetPath, sourceA);

  const unknownMimeFixture = await createFixture();
  await writeSourceBundle(unknownMimeFixture.sourcePath, "a");
  await syncSpa(unknownMimeFixture);
  const unknownBefore = await snapshotTree(unknownMimeFixture.targetPath);
  await writeFile(join(unknownMimeFixture.sourcePath, "assets", "payload.bin"), "unknown\n");

  await assert.rejects(() => syncSpa(unknownMimeFixture), /unknown MIME/u);
  assert.deepEqual(await snapshotTree(unknownMimeFixture.targetPath), unknownBefore);
});

test(
  "syncSpa rejects non-regular source entries while preserving the active version",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    await writeSourceBundle(fixture.sourcePath);
    await syncSpa(fixture);
    const before = await snapshotTree(fixture.targetPath);
    await execFileAsync("mkfifo", [join(fixture.sourcePath, "assets", "stream.css")]);

    await assert.rejects(() => syncSpa(fixture), /regular file/u);
    assert.deepEqual(await snapshotTree(fixture.targetPath), before);
  },
);

test("syncSpa and checkSpa reject a symlinked target instead of following it", async () => {
  const fixture = await createFixture();
  await writeSourceBundle(fixture.sourcePath);
  await rm(fixture.targetPath, { recursive: true });
  const redirectedTarget = join(fixture.rootPath, "redirected-target");
  await mkdir(redirectedTarget);
  await writeFile(join(redirectedTarget, "sentinel.txt"), "outside\n");
  await symlink(redirectedTarget, fixture.targetPath);

  await assert.rejects(() => syncSpa(fixture), /target.*symbolic link/u);
  await assert.rejects(() => checkSpa(fixture), /symbolic link/u);
  assert.equal(await readFile(join(redirectedTarget, "sentinel.txt"), "utf8"), "outside\n");
});
