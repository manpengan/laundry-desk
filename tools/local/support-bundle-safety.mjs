import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

export const SUPPORT_BUNDLE_MAXIMUM_BYTES = 512 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANAGED_NAME = /^[A-Za-z0-9_.-]{1,160}$/u;

export class SupportBundleError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "SupportBundleError";
    this.code = code;
  }
}

export const failSupportBundle = (code, cause) => {
  throw new SupportBundleError(code, cause === undefined ? undefined : { cause });
};

const mode = (metadata) => metadata.mode & 0o7777;

function assertManagedName(name) {
  if (
    typeof name !== "string" ||
    !MANAGED_NAME.test(name) ||
    basename(name) !== name ||
    name === "." ||
    name === ".."
  ) {
    failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID");
  }
}

function assertContained(root, candidate) {
  const path = relative(root, candidate);
  if (path === "" || path.startsWith("..") || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID");
  }
}

export async function assertManagedDirectory(path, expectedMode = PRIVATE_DIRECTORY_MODE) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    failSupportBundle("LOCAL_SUPPORT_DIRECTORY_INVALID");
  }
  const metadata = await lstat(path).catch((error) => {
    failSupportBundle("LOCAL_SUPPORT_DIRECTORY_INVALID", error);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || mode(metadata) !== expectedMode) {
    failSupportBundle("LOCAL_SUPPORT_DIRECTORY_INVALID");
  }
  const canonical = await realpath(path).catch((error) => {
    failSupportBundle("LOCAL_SUPPORT_DIRECTORY_INVALID", error);
  });
  if (canonical !== resolvePath(path)) {
    failSupportBundle("LOCAL_SUPPORT_DIRECTORY_INVALID");
  }
  return canonical;
}

export async function ensurePrivateDirectory(parent, name) {
  assertManagedName(name);
  const canonicalParent = await assertManagedDirectory(parent);
  const candidate = join(canonicalParent, name);
  assertContained(canonicalParent, candidate);
  try {
    await mkdir(candidate, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      failSupportBundle("LOCAL_SUPPORT_DIRECTORY_CREATE_FAILED", error);
    }
  }
  return await assertManagedDirectory(candidate);
}

export async function readManagedFile(
  root,
  name,
  maximumBytes,
  options = Object.freeze({ directoryMode: PRIVATE_DIRECTORY_MODE, fileMode: PRIVATE_FILE_MODE }),
) {
  assertManagedName(name);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID");
  }
  const canonicalRoot = await assertManagedDirectory(
    root,
    options.directoryMode ?? PRIVATE_DIRECTORY_MODE,
  );
  const candidate = join(canonicalRoot, name);
  assertContained(canonicalRoot, candidate);
  const before = await lstat(candidate).catch((error) => {
    failSupportBundle("LOCAL_SUPPORT_SOURCE_UNAVAILABLE", error);
  });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > maximumBytes ||
    mode(before) !== (options.fileMode ?? PRIVATE_FILE_MODE)
  ) {
    failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID");
  }
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error) => {
      failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID", error);
    },
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      mode(opened) !== (options.fileMode ?? PRIVATE_FILE_MODE)
    ) {
      failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      bytes.byteLength > maximumBytes ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1
    ) {
      failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readManagedJson(root, name, maximumBytes, options) {
  const bytes = await readManagedFile(root, name, maximumBytes, options);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    failSupportBundle("LOCAL_SUPPORT_SOURCE_INVALID", error);
  }
}

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function redactSupportText(input, roots = Object.freeze([])) {
  let output = String(input);
  for (const root of [...roots].filter((value) => typeof value === "string" && value.length > 0)) {
    output = output.replace(new RegExp(escapeRegularExpression(root), "gu"), "[REDACTED_PATH]");
  }
  output = output
    .replace(
      /-----BEGIN [^-]{1,64}-----[\s\S]{0,131072}?-----END [^-]{1,64}-----/gu,
      "[REDACTED_PEM]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,4096}/giu, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_JWT]")
    .replace(
      /([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,1024}@/gu,
      "$1[REDACTED]@",
    )
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b\s*:\s*)[^\r\n]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /("?[A-Za-z0-9_.-]*(?:authorization|cookie|token|csrf|password|passwd|secret|pin)[A-Za-z0-9_.-]*"?\s*:\s*)"(?:\\.|[^"\\])*"/giu,
      '$1"[REDACTED]"',
    )
    .replace(
      /(\b[A-Za-z0-9_.-]*(?:authorization|cookie|token|csrf|password|passwd|secret|pin)[A-Za-z0-9_.-]*\b\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/(\bPIN\b\s+)\d{4,12}\b/giu, "$1[REDACTED]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/(?:\/Users\/|\/home\/)[^/\s"',}\]]+(?:\/[^\s"',}\]]*)*/gu, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"',}\]]+(?:\\[^\s"',}\]]*)*/gu, "[REDACTED_PATH]");
  return output;
}

export function redactSupportValue(value, roots) {
  if (typeof value === "string") return redactSupportText(value, roots);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => redactSupportValue(entry, roots)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redactSupportValue(entry, roots)]),
      ),
    );
  }
  return value;
}

function supportTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    failSupportBundle("LOCAL_SUPPORT_CLOCK_INVALID");
  }
  return `${date.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;
}

function randomSuffix(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(12);
  } catch (error) {
    failSupportBundle("LOCAL_SUPPORT_RANDOM_FAILED", error);
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) {
    failSupportBundle("LOCAL_SUPPORT_RANDOM_FAILED");
  }
  return Buffer.from(bytes).subarray(0, 12).toString("hex");
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function installSupportBundle(
  configDirectory,
  bytes,
  dependencies = Object.freeze({
    now: () => new Date(),
    randomBytes: secureRandomBytes,
  }),
) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    failSupportBundle("LOCAL_SUPPORT_BUNDLE_INVALID");
  }
  if (bytes.byteLength > SUPPORT_BUNDLE_MAXIMUM_BYTES) {
    failSupportBundle("LOCAL_SUPPORT_BUNDLE_TOO_LARGE");
  }
  const outputDirectory = await ensurePrivateDirectory(configDirectory, "support-bundles");
  const suffix = randomSuffix(dependencies.randomBytes);
  const name = `laundry-v2-support-${supportTimestamp(dependencies.now())}-${suffix}.json`;
  const temporary = join(outputDirectory, `.${name}.staging`);
  const finalPath = join(outputDirectory, name);
  let installed = false;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    PRIVATE_FILE_MODE,
  ).catch((error) => {
    failSupportBundle("LOCAL_SUPPORT_STAGING_FAILED", error);
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    failSupportBundle("LOCAL_SUPPORT_WRITE_FAILED", error);
  }
  await handle.close();
  try {
    await link(temporary, finalPath);
    installed = true;
    await unlink(temporary);
    await syncDirectory(outputDirectory);
    const metadata = await lstat(finalPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      mode(metadata) !== PRIVATE_FILE_MODE ||
      metadata.size !== bytes.byteLength
    ) {
      failSupportBundle("LOCAL_SUPPORT_INSTALL_FAILED");
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (installed) await unlink(finalPath).catch(() => undefined);
    if (error instanceof SupportBundleError) throw error;
    failSupportBundle("LOCAL_SUPPORT_INSTALL_FAILED", error);
  }
  const installedBytes = await readManagedFile(
    outputDirectory,
    name,
    SUPPORT_BUNDLE_MAXIMUM_BYTES,
  ).catch(async (error) => {
    await unlink(finalPath).catch(() => undefined);
    failSupportBundle("LOCAL_SUPPORT_INSTALL_FAILED", error);
  });
  if (!Buffer.from(installedBytes).equals(Buffer.from(bytes))) {
    await unlink(finalPath).catch(() => undefined);
    failSupportBundle("LOCAL_SUPPORT_INSTALL_FAILED");
  }
  return Object.freeze({
    path: finalPath,
    sha256: createHash("sha256").update(installedBytes).digest("hex"),
    bytes: installedBytes.byteLength,
  });
}
