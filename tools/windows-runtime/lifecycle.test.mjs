import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, chmod, rename, open, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storage,
  withOperationLock,
  requireCompatible,
  requireState,
} from "./lifecycle-storage.mjs";
import { cleanEnvironment } from "./lifecycle-environment.mjs";

const entry = {
  digest: "a".repeat(64),
  release: "0.1.0-win-dev",
  source: "b".repeat(40),
  migrationHead: "0069_bounded_automation.sql",
  migrations: "c".repeat(64),
};
const platform = {
  securePrivateFile: (path) => chmod(path, 0o600),
  securePrivateDirectory: (path) => chmod(path, 0o700),
  inspectPrivateFile: async (path) => {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error("PRIVATE_FILE_INVALID");
  },
  inspectPrivateDirectory: async (path) => {
    if (!(await lstat(path)).isDirectory()) throw new Error("PRIVATE_DIRECTORY_INVALID");
  },
  replaceFileWriteThrough: rename,
  flushDirectoryDurably: async (path) => {
    if (process.platform === "win32") return; // Real Win32 flush failures run in lifecycle acceptance.
    const fd = await open(path);
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  },
};

test("version changes reject migration head AND aggregate differences", () => {
  assert.doesNotThrow(() => requireCompatible(entry, { ...entry, digest: "d".repeat(64) }));
  for (const mutation of [{ migrationHead: "0070_changed.sql" }, { migrations: "d".repeat(64) }])
    assert.throws(
      () => requireCompatible(entry, { ...entry, ...mutation }),
      /MIGRATION_CHANGE_REQUIRES_RESTORE/u,
    );
});

test("persistent state rejects extra authority, malformed paths and missing controller", () => {
  const state = {
    schema: 1,
    assurance: "development_only",
    phase: "stopped",
    current: entry,
    previous: null,
    controller: entry,
    pending: null,
  };
  assert.equal(requireState(state), state);
  for (const changed of [
    { ...state, controller: null },
    { ...state, root: "C:\\arbitrary" },
    { ...state, assurance: "production" },
    { ...state, current: { ...entry, digest: "../escape" } },
  ])
    assert.throws(() => requireState(changed), /STATE_INVALID/u);
});

test("launcher inherits only explicit OS context; secrets and injection are dropped", () => {
  const env = cleanEnvironment({
    SystemRoot: "C:\\Windows",
    NODE_OPTIONS: "--require evil",
    NODE_PATH: "evil",
    DATABASE_URL: "secret",
    PGHOST: "evil",
    LAUNDRY_PUBLIC_ORIGIN: "evil",
    LAUNDRY_UNKNOWN: "evil",
    PATH: "evil",
    npm_execpath: "evil",
    PSModulePath: "evil",
  });
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "DATABASE_URL",
    "PGHOST",
    "LAUNDRY_PUBLIC_ORIGIN",
    "LAUNDRY_UNKNOWN",
    "npm_execpath",
  ])
    assert.equal(env[key], undefined);
  assert.ok(!Object.values(env).includes("evil"));
});

for (const point of ["before-replace", "after-replace", "after-flush"]) {
  test(`commit failure at ${point} leaves one complete recoverable pointer`, async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-pointer-"));
    try {
      const path = join(root, "state.json");
      await storage(platform).write(path, JSON.stringify({ version: "old" }));
      const io = storage(platform, async (phase) => {
        if (phase === point) throw new Error("INJECTED");
      });
      await assert.rejects(io.write(path, JSON.stringify({ version: "new" })), /INJECTED/u);
      assert.deepEqual(JSON.parse(await readFile(path)), {
        version: point === "before-replace" ? "old" : "new",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("all lifecycle operations contend on one kernel-owned lock and release after errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-lock-"));
  try {
    await withOperationLock(root, async () => {
      await assert.rejects(
        withOperationLock(root, async () => assert.fail("concurrent entry")),
        /OPERATION_BUSY/u,
      );
    });
    await assert.rejects(
      withOperationLock(root, async () => {
        throw new Error("INJECTED");
      }),
      /INJECTED/u,
    );
    await withOperationLock(root, async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted uninstall validates the remaining manifest subset and preserves its recovery record", async () => {
  const { mkdir, writeFile, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { canonicalManifest, digest, REQUIRED_FILES } = await import("./companion-contract.mjs");
  const { COMPANION_SOURCES } = await import("./companion-sources.mjs");
  const { removeBoundPrograms } = await import("./lifecycle-release.mjs");
  const { reference } = await import("./lifecycle-storage.mjs");
  const root = await mkdtemp(join(tmpdir(), "laundry-uninstall-"));
  const names = [...REQUIRED_FILES, `migrations/${entry.migrationHead}`].sort();
  const bytes = Buffer.from("synthetic");
  const manifest = {
    schema: "laundry.windows.runtime-payload",
    version: 1,
    assurance: "development_only",
    platform: "win32-x64",
    source_git_sha: entry.source,
    runtime_release: entry.release,
    sources: COMPANION_SOURCES,
    migration_head: entry.migrationHead,
    migrations_sha256: entry.migrations,
    files: names.map((path) => ({ path, size: bytes.length, sha256: digest(bytes) })),
  };
  const canonical = canonicalManifest(manifest);
  const hash = digest(canonical);
  const release = reference(manifest, hash);
  const folder = join(root, "releases", hash);
  try {
    for (const path of names) {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await writeFile(join(folder, path), bytes);
    }
    await writeFile(join(folder, "runtime-payload.json"), canonical);
    await writeFile(join(folder, "unowned.txt"), bytes);
    await assert.rejects(
      removeBoundPrograms(root, release, platform),
      /UNINSTALL_CONTENT_CHANGED/u,
    );
    assert.deepEqual(await readFile(join(folder, names[0])), bytes);
    await unlink(join(folder, "unowned.txt"));
    await writeFile(join(folder, names[0]), "changed");
    await assert.rejects(
      removeBoundPrograms(root, release, platform),
      /UNINSTALL_CONTENT_CHANGED/u,
    );
    await unlink(join(folder, names[0])); // Simulate a crash after one bound file was deleted.
    await removeBoundPrograms(root, release, platform);
    await removeBoundPrograms(root, release, platform);
    assert.equal(await readFile(join(folder, "runtime-payload.json"), "utf8"), canonical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
