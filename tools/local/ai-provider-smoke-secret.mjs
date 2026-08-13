import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const MAX_SECRET_BYTES = 8_192;

export function readPrivateCredential(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("SMOKE_CREDENTIAL_FILE_INVALID");
  }
  let descriptor = null;
  let raw = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 8 ||
      metadata.size > MAX_SECRET_BYTES + 2
    )
      throw new Error("SMOKE_CREDENTIAL_FILE_INVALID");
    raw = readFileSync(descriptor);
    if (raw.byteLength !== metadata.size) throw new Error("SMOKE_CREDENTIAL_FILE_INVALID");
    let end = raw.byteLength;
    if (raw[end - 1] === 0x0a) {
      end -= 1;
      if (raw[end - 1] === 0x0d) end -= 1;
    }
    const secret = Buffer.from(raw.subarray(0, end));
    if (
      secret.byteLength < 8 ||
      secret.byteLength > MAX_SECRET_BYTES ||
      secret.some((byte) => byte < 0x21 || byte > 0x7e)
    ) {
      secret.fill(0);
      throw new Error("SMOKE_CREDENTIAL_FILE_INVALID");
    }
    return secret;
  } catch (error) {
    if (error instanceof Error && error.message === "SMOKE_CREDENTIAL_FILE_INVALID") throw error;
    throw new Error("SMOKE_CREDENTIAL_FILE_INVALID");
  } finally {
    raw?.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}
