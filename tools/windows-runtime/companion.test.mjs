import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  canonicalManifest,
  digest,
  MANIFEST_NAME,
  parseManifest,
  REQUIRED_FILES,
  requireManifest,
  requirePayloadPath,
} from "./companion-contract.mjs";
import { inventory } from "./companion-files.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";
import { COMPANION_SOURCES } from "./companion-sources.mjs";

function pe() {
  // Synthetic header used solely for structural inspector tests; never executed.
  const bytes = Buffer.alloc(90);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "laundry-companion-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [...REQUIRED_FILES, "migrations/0001_initial.sql"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      path.endsWith(".exe")
        ? pe()
        : path.endsWith(".exe.sha256")
          ? `${digest(pe())}\n`
          : "synthetic fixture\n",
    );
  }
  const manifest = {
    schema: "laundry.windows.runtime-payload",
    version: 1,
    assurance: "development_only",
    platform: "win32-x64",
    source_git_sha: "a".repeat(40),
    runtime_release: "0.1.0-win-dev",
    sources: COMPANION_SOURCES,
    migration_head: "0001_initial.sql",
    migrations_sha256: "b".repeat(64),
    files: (await inventory(root)).files,
  };
  const bytes = canonicalManifest(manifest);
  await writeFile(join(root, MANIFEST_NAME), bytes);
  return { root, manifest, bytes, hash: digest(bytes) };
}

test("a complete synthetic payload verifies only against its external manifest digest", async (t) => {
  const { root, manifest, hash } = await fixture(t);
  assert.deepEqual(await inspectCompanion(root, hash), manifest);
  await assert.rejects(inspectCompanion(root, "0".repeat(64)), /MANIFEST_DIGEST_INVALID/u);
  await assert.rejects(inspectCompanion(root, undefined), /MANIFEST_DIGEST_INVALID/u);
});

test("payload tampering, removal and extra files fail complete inventory verification", async (t) => {
  for (const mutation of ["tamper", "remove", "extra"]) {
    const { root, hash } = await fixture(t);
    const file = join(root, "metadata/schema.md");
    if (mutation === "tamper") await writeFile(file, "different bytes");
    if (mutation === "remove") await rm(file);
    if (mutation === "extra") await writeFile(join(root, "unexpected.txt"), "extra");
    await assert.rejects(inspectCompanion(root, hash), /INVENTORY_MISMATCH/u);
  }
});

test("unlisted empty directories, symlinks and hardlinks are rejected", async (t) => {
  const { root, hash } = await fixture(t);
  await mkdir(join(root, "extra"));
  await assert.rejects(inspectCompanion(root, hash), /UNLISTED_DIRECTORY/u);
  await rm(join(root, "extra"), { recursive: true });
  await link(join(root, "metadata/schema.md"), join(root, "extra.txt"));
  await assert.rejects(inspectCompanion(root, hash), /FILE_INVALID/u);
  await rm(join(root, "extra.txt"));
  await symlink(join(root, "metadata"), join(root, "alias"), "junction");
  await assert.rejects(inspectCompanion(root, hash), /LINK_FORBIDDEN/u);
});

test("Windows path aliases, traversal, credentials and case collisions are rejected", async (t) => {
  for (const path of [
    "../outside",
    "a//b",
    "a\\b",
    "C:/file",
    "/absolute",
    "a/NUL.txt",
    "a/COM1",
    "a/file.",
    "a/file ",
    "a/file:stream",
    ".git/config",
    "server/.env",
    "server/.env.production",
  ]) {
    assert.throws(() => requirePayloadPath(path), /PATH_INVALID/u, path);
  }
  const { manifest } = await fixture(t);
  const value = structuredClone(manifest);
  value.files.push({ ...value.files[0], path: value.files[0].path.toUpperCase() });
  value.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.throws(() => requireManifest(value), /FILE_SET_INVALID/u);
});

test("manifest schema rejects production claims, missing components and ambiguous file parents", async (t) => {
  const { manifest } = await fixture(t);
  for (const mutate of [
    (value) => {
      value.assurance = "production";
    },
    (value) => {
      value.install_authorized = true;
    },
    (value) => {
      value.source_git_sha = "main";
    },
    (value) => {
      value.sources.node.url = "https://example.invalid/node.zip";
    },
    (value) => {
      value.files = value.files.filter((entry) => entry.path !== "node/node.exe");
    },
    (value) => {
      value.files.push({ path: "server", size: 0, sha256: "a".repeat(64) });
      value.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    },
  ]) {
    const value = structuredClone(manifest);
    mutate(value);
    assert.throws(() => requireManifest(value), /WINDOWS_COMPANION_/u);
  }
});

test("canonical parsing rejects duplicate keys and does not expose malformed input", async (t) => {
  const { bytes } = await fixture(t);
  const duplicated = bytes.replace('"version": 1', '"version": 1, "version": 1');
  assert.throws(
    () => parseManifest(Buffer.from(duplicated), digest(duplicated)),
    /MANIFEST_NOT_CANONICAL/u,
  );
  const malformed = Buffer.from('{"secret":"synthetic-do-not-echo",broken}');
  assert.throws(
    () => parseManifest(malformed, digest(malformed)),
    (error) => {
      assert.equal(error.message, "WINDOWS_COMPANION_MANIFEST_JSON_INVALID");
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes("synthetic-do-not-echo"), false);
      return true;
    },
  );
});

test("a rehashed wrong-architecture binary still fails inspection", async (t) => {
  const { root, manifest } = await fixture(t);
  const bytes = pe();
  bytes.writeUInt16LE(0x14c, 68);
  await writeFile(join(root, "node/node.exe"), bytes);
  manifest.files = (await inventory(root, [MANIFEST_NAME])).files;
  const text = canonicalManifest(manifest);
  await writeFile(join(root, MANIFEST_NAME), text);
  await assert.rejects(inspectCompanion(root, digest(text)), /PE_INVALID/u);
});

test("helper sidecar must match the helper inside the bound payload", async (t) => {
  const { root, manifest } = await fixture(t);
  const sidecar = REQUIRED_FILES.find((name) => name.endsWith("exe.sha256"));
  await writeFile(join(root, sidecar), `${"0".repeat(64)}\n`);
  manifest.files = (await inventory(root, [MANIFEST_NAME])).files;
  const text = canonicalManifest(manifest);
  await writeFile(join(root, MANIFEST_NAME), text);
  await assert.rejects(inspectCompanion(root, digest(text)), /HELPER_DIGEST_MISMATCH/u);
  assert.equal((await readFile(join(root, sidecar), "utf8")).length, 65);
});

test("release staging copies into a private staging directory and publishes only verified content", async (t) => {
  const { stageRelease } = await import("./lifecycle-release.mjs");
  const { root: source, hash, manifest } = await fixture(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), "laundry-stage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "releases"));
  const calls = [];
  const platform = {
    securePrivateDirectory: async (path) => {
      calls.push(["private", path]);
    },
    flushDirectoryDurably: async (path) => {
      calls.push(["flush", path]);
    },
  };
  const result = await stageRelease(root, source, hash, platform);
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.payload, join(root, "releases", hash));
  assert.equal(calls[0][0], "private");
  assert.deepEqual(calls.at(-1), ["flush", join(root, "releases")]);
  assert.deepEqual(await inspectCompanion(result.payload, hash), manifest);
  assert.deepEqual(await stageRelease(root, source, hash, platform), result);
  const { removeBoundPrograms } = await import("./lifecycle-release.mjs");
  const { reference } = await import("./lifecycle-storage.mjs");
  await removeBoundPrograms(root, reference(manifest, hash), platform);
  assert.deepEqual(await stageRelease(root, source, hash, platform), result);
});
