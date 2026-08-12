import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { sha256DataProtectionFile } from "./hk-vps-data-protection-hash.mjs";
import { CloudReleaseError, fail } from "./hk-vps-release-core.mjs";

const COPY_BUFFER_BYTES = 1024 * 1024;

export async function copyDataProtectionFileOffsite(
  source,
  destination,
  expectedBytes,
  expectedSha256,
) {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("CLOUD_DATA_OFFSITE_SOURCE_INVALID");
  }
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedSource = await sourceHandle.stat();
    if (
      openedSource.dev !== before.dev ||
      openedSource.ino !== before.ino ||
      openedSource.size !== before.size ||
      openedSource.size !== expectedBytes
    ) {
      fail("CLOUD_DATA_OFFSITE_SOURCE_INVALID");
    }
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    while (copied < openedSource.size) {
      const read = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.length, openedSource.size - copied),
        null,
      );
      if (read.bytesRead < 1) fail("CLOUD_DATA_OFFSITE_SOURCE_INVALID");
      hash.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          read.bytesRead - written,
          null,
        );
        if (result.bytesWritten < 1) fail("CLOUD_DATA_OFFSITE_COPY_INVALID");
        written += result.bytesWritten;
      }
      copied += read.bytesRead;
    }
    await destinationHandle.chmod(0o600);
    await destinationHandle.sync();
    const afterSource = await sourceHandle.stat();
    const openedTarget = await destinationHandle.stat();
    const sourcePath = await lstat(source);
    const targetPath = await lstat(destination);
    if (
      copied !== expectedBytes ||
      hash.digest("hex") !== expectedSha256 ||
      afterSource.dev !== openedSource.dev ||
      afterSource.ino !== openedSource.ino ||
      afterSource.size !== openedSource.size ||
      afterSource.mtimeMs !== openedSource.mtimeMs ||
      afterSource.ctimeMs !== openedSource.ctimeMs ||
      sourcePath.dev !== openedSource.dev ||
      sourcePath.ino !== openedSource.ino ||
      openedTarget.size !== expectedBytes ||
      openedTarget.nlink !== 1 ||
      (openedTarget.mode & 0o7777) !== 0o600 ||
      targetPath.dev !== openedTarget.dev ||
      targetPath.ino !== openedTarget.ino
    ) {
      fail("CLOUD_DATA_OFFSITE_COPY_INVALID");
    }
  } catch (error) {
    if (error instanceof CloudReleaseError && error.code.startsWith("CLOUD_DATA_")) throw error;
    fail("CLOUD_DATA_OFFSITE_COPY_INVALID", error);
  } finally {
    await Promise.all([
      sourceHandle?.close().catch(() => undefined),
      destinationHandle?.close().catch(() => undefined),
    ]);
  }
}

export async function copySmallDataProtectionFileOffsite(source, destination) {
  const metadata = await lstat(source);
  await copyDataProtectionFileOffsite(
    source,
    destination,
    metadata.size,
    await sha256DataProtectionFile(source, { code: "CLOUD_DATA_OFFSITE_SOURCE_INVALID" }),
  );
}
