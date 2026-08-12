import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { fail } from "./hk-vps-release-core.mjs";

const HASH_BUFFER_BYTES = 1024 * 1024;

export async function sha256DataProtectionFile(path, options = {}) {
  const code = options.code ?? "CLOUD_DATA_FILE_HASH_INVALID";
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1
  ) {
    fail(code);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      fail(code);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let bytes = 0;
    while (bytes < opened.size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - bytes), null);
      if (read.bytesRead < 1) fail(code);
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      bytes !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    ) {
      fail(code);
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === code) throw error;
    fail(code, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
