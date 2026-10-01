import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CRT_SOURCE } from "./companion-crt-source.mjs";
import {
  extractCompanionCrt,
  readBoundedCrtBytes,
  readCrtArchive,
  requireCrtCabinet,
  splitCrtCabinets,
} from "./extract-companion-crt.mjs";
import { packageArguments } from "./package-companion.mjs";

const failure = (code) => ({ message: `WINDOWS_COMPANION_CRT_${code}` });
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-crt-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("CAB extraction cannot begin for an unauthenticated EXE", () => {
  for (const bytes of [null, Buffer.alloc(1), Buffer.alloc(CRT_SOURCE.size)]) {
    assert.throws(() => splitCrtCabinets(bytes), failure("DIGEST_MISMATCH"));
  }
});

test("signed CAB trailers are accepted only with the pinned full digest and cabinet length", () => {
  const bytes = Buffer.alloc(56);
  bytes.write("MSCF", 0, "ascii");
  bytes.writeUInt32LE(40, 8);
  const pin = {
    size: 56,
    cabinet_size: 40,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  assert.equal(requireCrtCabinet(bytes, pin), bytes);
  for (const changed of [
    { ...pin, cabinet_size: 56 },
    { ...pin, cabinet_size: 0 },
    { ...pin, cabinet_size: 57 },
    { ...pin, sha256: "f".repeat(64) },
  ])
    assert.throws(() => requireCrtCabinet(bytes, changed), failure("CAB_INVALID"));
  const alteredTrailer = Buffer.from(bytes);
  alteredTrailer[55] = 1;
  assert.throws(() => requireCrtCabinet(alteredTrailer, pin), failure("CAB_INVALID"));
  const unsigned = Buffer.from(bytes.subarray(0, 40));
  assert.equal(
    requireCrtCabinet(unsigned, {
      size: 40,
      sha256: createHash("sha256").update(unsigned).digest("hex"),
    }),
    unsigned,
  );
});

test("archive arguments are rejected before filesystem use", async () => {
  for (const value of [null, 1, "", "a\0b"])
    await assert.rejects(readCrtArchive(value), failure("ARCHIVE_INVALID"));
});

test("the actual bounded reader detects an append while allocating only the pinned size", async () => {
  const calls = [];
  let source = Buffer.from("123456");
  const handle = {
    async read(buffer, offset, length, position) {
      calls.push({ allocation: buffer.length, length, position });
      const bytesRead = Math.min(length, source.length - position, 3);
      source.copy(buffer, offset, position, position + bytesRead);
      if (calls.length === 1) source = Buffer.concat([source, Buffer.alloc(1000000)]);
      return { bytesRead };
    },
  };
  await assert.rejects(readBoundedCrtBytes(handle, 6), failure("FILE_CHANGED"));
  assert.deepEqual(calls, [
    { allocation: 6, length: 6, position: 0 },
    { allocation: 6, length: 3, position: 3 },
    { allocation: 1, length: 1, position: 6 },
  ]);
  await assert.rejects(
    readBoundedCrtBytes({ read: async () => ({ bytesRead: 0 }) }, 6),
    failure("FILE_CHANGED"),
  );
  await assert.rejects(readBoundedCrtBytes(handle, CRT_SOURCE.size + 1), failure("FILE_INVALID"));
});

test("wrong source size and same-size wrong digest cannot produce payload files", async (t) => {
  const root = await temporary(t);
  const archive = join(root, "public.exe");
  await writeFile(archive, "wrong public source");
  await assert.rejects(readCrtArchive(archive), failure("FILE_INVALID"));
  const file = await open(archive, "r+");
  try {
    await file.truncate(CRT_SOURCE.size);
  } finally {
    await file.close();
  }
  await assert.rejects(readCrtArchive(archive), failure("DIGEST_MISMATCH"));
  assert.deepEqual(await readdir(root), ["public.exe"]);
});

test("hard-linked archive is rejected before reading bytes", async (t) => {
  const root = await temporary(t);
  const archive = join(root, "public.exe");
  await writeFile(archive, "invalid");
  await link(archive, join(root, "alias.exe"));
  await assert.rejects(readCrtArchive(archive), failure("FILE_INVALID"));
});

test("symbolic archive aliases are rejected", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "public.exe"), "invalid");
  try {
    await symlink(join(root, "public.exe"), join(root, "alias.exe"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Windows symlink privilege unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(readCrtArchive(join(root, "alias.exe")), failure("FILE_INVALID"));
});

test(
  "extractor is restricted to Windows x64 before any payload mutation",
  { skip: process.platform === "win32" && process.arch === "x64" },
  async (t) => {
    const root = await temporary(t);
    await mkdir(join(root, "payload"));
    await assert.rejects(
      extractCompanionCrt("invalid", join(root, "payload"), {}),
      failure("BUILD_PLATFORM_INVALID"),
    );
    assert.deepEqual(await readdir(join(root, "payload")), []);
  },
);

test("build CLI requires a CRT archive and preserves paths as literal arguments", () => {
  const args = [
    "--source-sha",
    "a".repeat(40),
    "--node-archive",
    "C:/public/node.zip",
    "--postgres-archive",
    "C:/public/postgres.zip",
    "--crt-archive",
    "C:/public/CRT with spaces.exe",
    "--release",
    "0.1.4-win-dev.1",
  ];
  assert.deepEqual(packageArguments(args), {
    sourceSha: args[1],
    nodeArchive: args[3],
    postgresArchive: args[5],
    crtArchive: args[7],
    release: args[9],
  });
  for (const invalid of [
    args.slice(0, 6).concat(args.slice(8)),
    [...args, "extra"],
    args.map((arg, index) => (index === 6 ? "--release" : arg)),
    args.map((arg, index) => (index === 7 ? "" : arg)),
    args.map((arg, index) => (index === 7 ? "x\0y" : arg)),
    null,
  ]) {
    assert.throws(() => packageArguments(invalid), { message: "WINDOWS_COMPANION_ARGS_INVALID" });
  }
});
