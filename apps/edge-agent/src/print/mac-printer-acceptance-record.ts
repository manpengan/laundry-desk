import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { MacPrinterAcceptanceRecord } from "./mac-printer-acceptance.js";

export type MacPrinterAcceptanceWriteHooks = Readonly<{
  afterCwdBound?: () => void;
  afterPathCheck?: () => void;
}>;

class MacPrinterAcceptanceWriteError extends Error {}
let recordWriterTail: Promise<void> = Promise.resolve();

function sameDirectoryIdentity(expected: BigIntStats, observed: BigIntStats): boolean {
  return (
    observed.isDirectory() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino &&
    observed.nlink >= 1n &&
    (observed.mode & 0o777n) === 0o700n
  );
}

function sameFileVersion(expected: BigIntStats, observed: BigIntStats): boolean {
  return (
    expected.isFile() &&
    expected.nlink === 1n &&
    (expected.mode & 0o777n) === 0o600n &&
    observed.isFile() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino &&
    observed.mode === expected.mode &&
    observed.nlink === 1n &&
    observed.size === expected.size &&
    observed.ctimeNs === expected.ctimeNs &&
    observed.mtimeNs === expected.mtimeNs
  );
}

function pathStillNamesDirectory(directory: string, identity: BigIntStats): boolean {
  try {
    const observed = lstatSync(directory, { bigint: true });
    return (
      !observed.isSymbolicLink() &&
      sameDirectoryIdentity(identity, observed) &&
      realpathSync(directory) === directory
    );
  } catch {
    return false;
  }
}

function createRecordInBoundDirectory(
  directory: string,
  fileName: string,
  contents: string,
  identity: BigIntStats,
  hooks: MacPrinterAcceptanceWriteHooks,
): void {
  const previousDirectory = process.cwd();
  let descriptor: number | null = null;
  let createdIdentity: BigIntStats | null = null;
  let completed = false;
  try {
    process.chdir(directory);
    if (!sameDirectoryIdentity(identity, lstatSync(".", { bigint: true }))) {
      throw new MacPrinterAcceptanceWriteError("acceptance directory changed before writing");
    }
    hooks.afterCwdBound?.();
    if (!pathStillNamesDirectory(directory, identity)) {
      throw new MacPrinterAcceptanceWriteError("acceptance directory changed before writing");
    }
    hooks.afterPathCheck?.();
    descriptor = openSync(
      fileName,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || (opened.mode & 0o777n) !== 0o600n) {
      throw new MacPrinterAcceptanceWriteError("acceptance record file is unsafe");
    }
    createdIdentity = opened;
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    const afterWrite = fstatSync(descriptor, { bigint: true });
    const byBoundPath = lstatSync(fileName, { bigint: true });
    if (
      !sameFileVersion(afterWrite, byBoundPath) ||
      afterWrite.size !== BigInt(Buffer.byteLength(contents, "utf8")) ||
      !sameDirectoryIdentity(identity, lstatSync(".", { bigint: true })) ||
      !pathStillNamesDirectory(directory, identity)
    ) {
      throw new MacPrinterAcceptanceWriteError("acceptance record changed while writing");
    }
    completed = true;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (!completed && createdIdentity !== null) {
      try {
        const observed = lstatSync(fileName, { bigint: true });
        if (
          observed.isFile() &&
          observed.dev === createdIdentity.dev &&
          observed.ino === createdIdentity.ino
        ) {
          unlinkSync(fileName);
        }
      } catch {
        // Fail closed without unlinking any path whose identity cannot be proven.
      }
    }
    process.chdir(previousDirectory);
  }
}

async function writeMacPrinterAcceptanceRecordExclusive(
  directory: string,
  record: MacPrinterAcceptanceRecord,
  hooks: MacPrinterAcceptanceWriteHooks = {},
): Promise<string> {
  try {
    if (!isAbsolute(directory) || resolve(directory) !== directory) {
      throw new MacPrinterAcceptanceWriteError(
        "acceptance directory must be canonical and absolute",
      );
    }
    if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
      throw new MacPrinterAcceptanceWriteError(
        "acceptance records require no-follow directory support",
      );
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pathMetadata = await lstat(directory, { bigint: true });
    if (
      !pathMetadata.isDirectory() ||
      pathMetadata.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    ) {
      throw new MacPrinterAcceptanceWriteError(
        "acceptance directory must be a real private directory",
      );
    }
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        opened.dev !== pathMetadata.dev ||
        opened.ino !== pathMetadata.ino ||
        !opened.isDirectory()
      ) {
        throw new MacPrinterAcceptanceWriteError("acceptance directory changed while opening");
      }
      await handle.chmod(0o700);
      const identity = await handle.stat({ bigint: true });
      if (
        !sameDirectoryIdentity(identity, identity) ||
        !pathStillNamesDirectory(directory, identity)
      ) {
        throw new MacPrinterAcceptanceWriteError("acceptance directory changed before writing");
      }
      const timestamp = record.accepted_at.replace(/[^0-9]/gu, "").slice(0, 17);
      const fileName = `xp58-${timestamp}-${randomUUID()}.json`;
      createRecordInBoundDirectory(
        directory,
        fileName,
        `${JSON.stringify(record, null, 2)}\n`,
        identity,
        hooks,
      );
      if (!pathStillNamesDirectory(directory, identity)) {
        throw new MacPrinterAcceptanceWriteError("acceptance directory changed while writing");
      }
      return join(directory, fileName);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof MacPrinterAcceptanceWriteError) throw error;
    throw new MacPrinterAcceptanceWriteError("acceptance record could not be written safely");
  }
}

export function writeMacPrinterAcceptanceRecord(
  directory: string,
  record: MacPrinterAcceptanceRecord,
  hooks: MacPrinterAcceptanceWriteHooks = {},
): Promise<string> {
  const run = recordWriterTail.then(
    () => writeMacPrinterAcceptanceRecordExclusive(directory, record, hooks),
    () => writeMacPrinterAcceptanceRecordExclusive(directory, record, hooks),
  );
  recordWriterTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
