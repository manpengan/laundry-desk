import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CRT_CABS, CRT_DLLS, CRT_LICENSE, CRT_SOURCE } from "./companion-crt-source.mjs";
import {
  createCrtMetadataBytes,
  crtFailure,
  CRT_LICENSE_NAME,
  CRT_METADATA_NAME,
  CRT_TARGET_DIRECTORIES,
} from "./companion-crt-contract.mjs";
import { requireRealDirectory } from "./companion-files.mjs";
import { requireX64Pe } from "./companion-pe.mjs";

const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sameFile(a, b) {
  return (
    b.isFile() &&
    b.nlink === 1 &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

export async function readBoundedCrtBytes(file, size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > CRT_SOURCE.size) crtFailure("FILE_INVALID");
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > size - offset)
      crtFailure("FILE_CHANGED");
    offset += bytesRead;
  }
  if ((await file.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) crtFailure("FILE_CHANGED");
  return bytes;
}

async function readPinnedFile(path, pin) {
  await requireRealDirectory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== pin.size)
    crtFailure("FILE_INVALID");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await file.stat())) crtFailure("FILE_CHANGED");
    const bytes = await readBoundedCrtBytes(file, pin.size);
    if (!sameFile(before, await file.stat()) || !sameFile(before, await lstat(path)))
      crtFailure("FILE_CHANGED");
    if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) crtFailure("DIGEST_MISMATCH");
    return bytes;
  } finally {
    await file.close();
  }
}

export async function readCrtArchive(archive) {
  if (typeof archive !== "string" || !archive || archive.includes("\0"))
    crtFailure("ARCHIVE_INVALID");
  return readPinnedFile(resolve(archive), CRT_SOURCE);
}

export function requireCrtCabinet(bytes, pin) {
  const cabinetSize = pin.cabinet_size ?? pin.size;
  if (
    !Buffer.isBuffer(bytes) ||
    !Number.isSafeInteger(cabinetSize) ||
    cabinetSize < 36 ||
    cabinetSize > pin.size ||
    bytes.length !== pin.size ||
    digest(bytes) !== pin.sha256 ||
    bytes.toString("ascii", 0, 4) !== "MSCF" ||
    bytes.readUInt32LE(8) !== cabinetSize
  )
    crtFailure("CAB_INVALID");
  return bytes;
}

// Only authenticated public data is sent to expand.exe; the EXE/MSI is never run.
export function splitCrtCabinets(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== CRT_SOURCE.size ||
    digest(bytes) !== CRT_SOURCE.sha256
  )
    crtFailure("DIGEST_MISMATCH");
  return Object.fromEntries(
    ["ui", "payload"].map((kind) => {
      const pin = CRT_CABS[kind];
      return [
        kind,
        requireCrtCabinet(Buffer.from(bytes.subarray(pin.offset, pin.offset + pin.size)), pin),
      ];
    }),
  );
}

async function createFile(path, bytes) {
  await requireRealDirectory(dirname(path));
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.length)
      crtFailure("FILE_CHANGED");
  } finally {
    await file.close();
  }
}

function extractionEnvironment(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|PSModulePath|LAUNDRY_|DATABASE_|PG)/iu.test(key))
      delete clean[key];
  }
  return clean;
}

async function expandOne(expand, cab, id, destination, env) {
  await mkdir(destination, { mode: 0o700 });
  try {
    await execute(expand, [`-F:${id}`, cab, destination], {
      cwd: destination,
      env,
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 65536,
    });
  } catch {
    crtFailure("EXTRACTION_FAILED");
  }
  const entries = await readdir(destination, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== id || !entries[0].isFile())
    crtFailure("EXTRACTION_INVALID");
  return join(destination, id);
}

async function requireExpand(systemRoot) {
  if (typeof systemRoot !== "string" || !/^[A-Za-z]:[\\/]Windows$/iu.test(systemRoot))
    crtFailure("SYSTEM_ROOT_INVALID");
  const expand = join(await requireRealDirectory(join(systemRoot, "System32")), "expand.exe");
  const info = await lstat(expand);
  if (!info.isFile() || info.isSymbolicLink()) crtFailure("SYSTEM_EXPAND_INVALID");
  return expand;
}

export async function extractCompanionCrt(archive, payload, env) {
  if (process.platform !== "win32" || process.arch !== "x64") crtFailure("BUILD_PLATFORM_INVALID");
  const root = await requireRealDirectory(payload);
  const targets = await Promise.all(
    CRT_TARGET_DIRECTORIES.map((directory) => requireRealDirectory(join(root, directory))),
  );
  await requireRealDirectory(join(root, "metadata"));
  const expand = await requireExpand(env?.SystemRoot);
  const cabinets = splitCrtCabinets(await readCrtArchive(archive));
  const work = await mkdtemp(join(root, ".crt-extract-"));
  try {
    const ui = join(work, "ui.cab");
    const payloadCab = join(work, "payload.cab");
    await createFile(ui, cabinets.ui);
    await createFile(payloadCab, cabinets.payload);
    const clean = extractionEnvironment(env);
    const minimum = await expandOne(
      expand,
      payloadCab,
      CRT_CABS.minimum.file_id,
      join(work, "minimum"),
      clean,
    );
    requireCrtCabinet(await readPinnedFile(minimum, CRT_CABS.minimum), CRT_CABS.minimum);
    const licensePath = await expandOne(
      expand,
      ui,
      CRT_LICENSE.file_id,
      join(work, "license"),
      clean,
    );
    const license = await readPinnedFile(licensePath, CRT_LICENSE);
    const files = [];
    for (const [index, pin] of CRT_DLLS.entries()) {
      const path = await expandOne(expand, minimum, pin.file_id, join(work, `dll-${index}`), clean);
      const bytes = await readPinnedFile(path, pin);
      await requireX64Pe(path);
      files.push({ pin, bytes });
    }
    // Validate every dependency before adding any CRT file to the payload.
    for (const { pin, bytes } of files) {
      for (const directory of targets) await createFile(join(directory, pin.name), bytes);
    }
    await mkdir(join(root, "metadata/licenses"), { mode: 0o700 });
    await createFile(join(root, CRT_LICENSE_NAME), license);
    await createFile(join(root, CRT_METADATA_NAME), createCrtMetadataBytes());
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
