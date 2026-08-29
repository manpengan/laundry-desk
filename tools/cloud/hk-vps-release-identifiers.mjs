import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;

export class CloudReleaseError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "CloudReleaseError";
    this.code = code;
  }
}

export function fail(code, cause) {
  throw new CloudReleaseError(code, cause === undefined ? undefined : { cause });
}

export function requireSha(value, code = "CLOUD_RELEASE_SHA_INVALID") {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail(code);
  return value;
}

export function requireDigest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("CLOUD_RELEASE_ARCHIVE_DIGEST_INVALID");
  }
  return value;
}

export function requireToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    fail("CLOUD_RELEASE_TOKEN_INVALID");
  }
  return value;
}

export function requireMigrationHead(value) {
  if (typeof value !== "string" || !MIGRATION_PATTERN.test(value)) {
    fail("CLOUD_RELEASE_MIGRATION_HEAD_INVALID");
  }
  return value;
}

export async function sha256File(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}
