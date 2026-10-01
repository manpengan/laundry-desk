import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalManifest, digest, MANIFEST_NAME, REQUIRED_FILES } from "./companion-contract.mjs";
import {
  createCrtMetadataBytes,
  CRT_LICENSE_NAME,
  CRT_METADATA_NAME,
} from "./companion-crt-contract.mjs";
import { inventory, readBoundedFile } from "./companion-files.mjs";
import { COMPANION_SOURCES } from "./companion-sources.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";

function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(90);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}
function canonical(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`);
}
async function fixture(t, machine = 0x8664, mutateMetadata = (value) => value) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "laundry-crt-inspector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  for (const path of [...REQUIRED_FILES, "migrations/0001_initial.sql"])
    await write(
      path,
      path.endsWith(".exe")
        ? pe()
        : path.endsWith(".exe.sha256")
          ? `${digest(pe())}\n`
          : "public synthetic fixture",
    );
  const library = pe(machine);
  const license = Buffer.from("public synthetic license");
  const previous = JSON.parse(createCrtMetadataBytes());
  const value = {
    ...previous,
    files: previous.files.map((file) => ({
      ...file,
      size: library.length,
      sha256: digest(library),
    })),
    license: { ...previous.license, size: license.length, sha256: digest(license) },
  };
  for (const file of value.files) for (const path of file.destinations) await write(path, library);
  await write(CRT_LICENSE_NAME, license);
  await write(CRT_METADATA_NAME, canonical(mutateMetadata(value)));
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
  await write(MANIFEST_NAME, bytes);
  return { root, manifest, hash: digest(bytes) };
}

test("the actual inspector binds a complete synthetic CRT cohort and both AMD64 copies", async (t) => {
  const { root, manifest, hash } = await fixture(t);
  assert.deepEqual(await inspectCompanion(root, hash), manifest);
});
test("rehashing a complete x86 CRT cohort does not bypass the actual PE inspector", async (t) => {
  const { root, hash } = await fixture(t, 0x14c);
  await assert.rejects(inspectCompanion(root, hash), /WINDOWS_COMPANION_PE_INVALID/u);
});
test("rehashed metadata cannot substitute the manifest-bound native dependency hash", async (t) => {
  const { root, hash } = await fixture(t, 0x8664, (value) => ({
    ...value,
    files: value.files.map((file, index) => (index ? file : { ...file, sha256: "c".repeat(64) })),
  }));
  await assert.rejects(inspectCompanion(root, hash), /WINDOWS_COMPANION_CRT_METADATA_MISMATCH/u);
});
test("the bounded metadata reader rejects oversized, altered and hard-linked inputs", async (t) => {
  const { root, manifest } = await fixture(t);
  const entry = manifest.files.find(({ path }) => path === CRT_METADATA_NAME);
  const path = join(root, entry.path);
  assert.equal((await readBoundedFile(path, entry, 65536)).length, entry.size);
  await assert.rejects(readBoundedFile(path, entry, entry.size - 1), /FILE_INVALID/u);
  await assert.rejects(
    readBoundedFile(path, { ...entry, sha256: "0".repeat(64) }, 65536),
    /FILE_DIGEST_MISMATCH/u,
  );
  await link(path, join(root, "public-metadata-alias"));
  await assert.rejects(readBoundedFile(path, entry, 65536), /FILE_INVALID/u);
});
