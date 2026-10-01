import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createCrtMetadataBytes,
  crtPayloadEntries,
  CRT_LICENSE_NAME,
  CRT_METADATA_NAME,
  CRT_TARGET_DIRECTORIES,
  requireCrtManifestFiles,
  requireCrtMetadata,
} from "./companion-crt-contract.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function encode(value) {
  function sorted(item) {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sorted(item[key])]),
      );
    return item;
  }
  return Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`);
}
function cohort(value) {
  const bytes = encode(value);
  const files = [
    ...value.files.flatMap((file) =>
      file.destinations.map((path) => ({ path, size: file.size, sha256: file.sha256 })),
    ),
    { path: CRT_LICENSE_NAME, size: value.license.size, sha256: value.license.sha256 },
    { path: CRT_METADATA_NAME, size: bytes.length, sha256: sha(bytes) },
  ];
  return { bytes, files };
}
const metadata = () => JSON.parse(createCrtMetadataBytes().toString("utf8"));
const failure = (code) => ({ message: `WINDOWS_COMPANION_CRT_${code}` });

test("legacy payload without any CRT cohort remains accepted", () => {
  assert.equal(
    requireCrtManifestFiles([
      { path: "postgres/bin/postgres.exe", size: 1, sha256: "a".repeat(64) },
    ]),
    false,
  );
  assert.equal(requireCrtManifestFiles([]), false);
});

test("current canonical metadata and complete 26-file manifest agree", () => {
  const files = crtPayloadEntries();
  const bytes = createCrtMetadataBytes();
  assert.equal(files.length, 26);
  assert.equal(requireCrtManifestFiles(files), true);
  assert.deepEqual(requireCrtMetadata(bytes, files), metadata());
  assert.notEqual(bytes, createCrtMetadataBytes());
  assert.deepEqual(createCrtMetadataBytes(), bytes);
});

test("another published CRT version and different bytes are rollback-compatible", () => {
  const original = metadata();
  const value = {
    ...original,
    source: {
      ...original.source,
      version: "14.42.34438.0",
      size: 24000000,
      sha256: sha(Buffer.from("older public redist")),
    },
    files: original.files.map((file, index) => ({
      ...file,
      version: "14.42.34438.0",
      size: 120000 + index,
      sha256: sha(Buffer.from(`older DLL ${index}`)),
    })),
    license: { ...original.license, size: 9000, sha256: sha(Buffer.from("older license")) },
  };
  const { bytes, files } = cohort(value);
  assert.equal(requireCrtManifestFiles(files), true);
  assert.deepEqual(requireCrtMetadata(bytes, files), value);
});

test("any partial cohort or marker without dependency copies is refused", () => {
  const files = crtPayloadEntries();
  for (const file of files)
    assert.throws(
      () => requireCrtManifestFiles(files.filter((entry) => entry.path !== file.path)),
      failure("CAPABILITY_INCOMPLETE"),
    );
  assert.throws(
    () => requireCrtManifestFiles(files.filter((entry) => entry.path === CRT_METADATA_NAME)),
    failure("CAPABILITY_INCOMPLETE"),
  );
});

test("mirrored DLL hashes and sizes must match", () => {
  const files = crtPayloadEntries();
  const path = `${CRT_TARGET_DIRECTORIES[0]}/msvcp140.dll`;
  for (const delta of [{ size: 2 }, { sha256: "b".repeat(64) }]) {
    assert.throws(
      () =>
        requireCrtManifestFiles(
          files.map((entry) => (entry.path === path ? { ...entry, ...delta } : entry)),
        ),
      failure("COHORT_MISMATCH"),
    );
  }
});

test("path aliases, wrong locations, duplicate paths and malformed entries fail closed", () => {
  const files = crtPayloadEntries();
  const first = files[0];
  for (const path of [
    first.path.toUpperCase(),
    first.path.replaceAll("/", "\\"),
    `other/${first.path.split("/").at(-1)}`,
  ]) {
    assert.throws(
      () => requireCrtManifestFiles([{ ...first, path }, ...files.slice(1)]),
      failure("MANIFEST_INVALID"),
    );
  }
  assert.throws(
    () => requireCrtManifestFiles([files[1], ...files.slice(1)]),
    failure("MANIFEST_INVALID"),
  );
  for (const entry of [
    null,
    [],
    { path: 1 },
    { ...first, sha256: [first.sha256] },
    { ...first, size: -1 },
    { ...first, extra: true },
  ]) {
    assert.throws(
      () => requireCrtManifestFiles([entry, ...files.slice(1)]),
      failure("MANIFEST_INVALID"),
    );
  }
});

test("strict source identity, schema, versions and named destinations are validated", () => {
  const original = metadata();
  const invalid = [
    { ...original, extra: true },
    { ...original, platform: "win32-arm64" },
    { ...original, source: { ...original.source, url: "https://example.com/VC_redist.x64.exe" } },
    {
      ...original,
      source: {
        ...original.source,
        url: original.source.url.replace("bd1c8d9d-ba95-4eee-bc6e-df1fcc876373", "-".repeat(36)),
      },
    },
    { ...original, source: { ...original.source, sha256: [original.source.sha256] } },
    { ...original, source: { ...original.source, version: "15.0.1.0" } },
    { ...original, license: { ...original.license, file_id: ["u4"] } },
    {
      ...original,
      files: original.files.map((file, index) =>
        index === 0 ? { ...file, version: "14.1.0.0" } : file,
      ),
    },
    {
      ...original,
      files: original.files.map((file, index) =>
        index === 0 ? { ...file, file_id: "different" } : file,
      ),
    },
    {
      ...original,
      files: original.files.map((file, index) =>
        index === 0 ? { ...file, destinations: [...file.destinations].reverse() } : file,
      ),
    },
  ];
  for (const value of invalid) {
    const bytes = encode(value);
    const files = crtPayloadEntries().map((entry) =>
      entry.path === CRT_METADATA_NAME
        ? { ...entry, size: bytes.length, sha256: sha(bytes) }
        : entry,
    );
    assert.throws(() => requireCrtMetadata(bytes, files), failure("METADATA_INVALID"));
  }
});

test("canonical encoding rejects duplicate keys and alternate encodings", () => {
  const bytes = createCrtMetadataBytes();
  for (const changed of [
    Buffer.from(bytes.toString().trimEnd()),
    Buffer.from(bytes.toString().replace('"version": 1', '"version": 1, "version": 1')),
    Buffer.from(bytes.toString().replaceAll("\n", "\r\n")),
  ]) {
    assert.throws(
      () => requireCrtMetadata(changed, crtPayloadEntries()),
      failure("METADATA_NOT_CANONICAL"),
    );
  }
  assert.throws(
    () => requireCrtMetadata(Buffer.from("{"), crtPayloadEntries()),
    failure("METADATA_INVALID"),
  );
  assert.throws(
    () => requireCrtMetadata(Buffer.alloc(65537), crtPayloadEntries()),
    failure("METADATA_INVALID"),
  );
});

test("metadata cannot substitute another DLL/license/metadata digest", () => {
  const original = metadata();
  for (const value of [
    {
      ...original,
      files: original.files.map((file, index) =>
        index === 0 ? { ...file, sha256: "e".repeat(64) } : file,
      ),
    },
    { ...original, license: { ...original.license, sha256: "f".repeat(64) } },
  ]) {
    const bytes = encode(value);
    const files = crtPayloadEntries().map((entry) =>
      entry.path === CRT_METADATA_NAME
        ? { ...entry, size: bytes.length, sha256: sha(bytes) }
        : entry,
    );
    assert.throws(() => requireCrtMetadata(bytes, files), failure("METADATA_MISMATCH"));
  }
  const files = crtPayloadEntries().map((entry) =>
    entry.path === CRT_METADATA_NAME ? { ...entry, sha256: "f".repeat(64) } : entry,
  );
  assert.throws(
    () => requireCrtMetadata(createCrtMetadataBytes(), files),
    failure("METADATA_MISMATCH"),
  );
});
