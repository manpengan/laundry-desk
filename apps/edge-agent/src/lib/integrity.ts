import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { mimeFor } from "./mime.js";

export type SpaManifestEntry = Readonly<{
  sha256: string;
  mime: string;
  bytes: number;
}>;

export type SpaManifest = Readonly<{
  version: 1;
  entries: Readonly<Record<string, SpaManifestEntry>>;
}>;

export type LoadedCanonicalManifest = Readonly<{
  manifest: SpaManifest;
  bundleId: string;
}>;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UNKNOWN_MIME = "application/octet-stream";

export function isNormalizedSpaPath(value: string): boolean {
  if (
    value.length === 0 ||
    value === "manifest.json" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }

  return (
    posix.normalize(value) === value &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function loadManifest(manifestPath: string): SpaManifest {
  return parseManifestText(readRegularFileNoFollow(manifestPath, "SPA manifest").toString("utf8"));
}

export function loadCanonicalManifest(manifestPath: string): LoadedCanonicalManifest {
  const rawManifest = readRegularFileNoFollow(manifestPath, "SPA manifest");
  const manifest = parseManifestText(rawManifest.toString("utf8"));
  const canonicalManifest = Buffer.from(serializeCanonicalManifest(manifest), "utf8");
  if (!rawManifest.equals(canonicalManifest)) {
    throw new Error("SPA manifest is not canonical");
  }
  return Object.freeze({
    manifest,
    bundleId: sha256Hex(rawManifest),
  });
}

function parseManifestText(rawManifest: string): SpaManifest {
  const parsed: unknown = JSON.parse(rawManifest);
  const validationError = manifestValidationError(parsed);
  if (validationError) {
    throw new Error(`Invalid SPA manifest: ${validationError}`);
  }
  return freezeManifest(parsed as SpaManifest);
}

export function isSpaManifest(value: unknown): value is SpaManifest {
  return manifestValidationError(value) === null;
}

export function verifySpaIntegrity(spaRoot: string, manifest: SpaManifest): SpaManifest {
  const validationError = manifestValidationError(manifest);
  if (validationError) {
    throw new Error(`Invalid SPA manifest: ${validationError}`);
  }

  const actualPaths = listRegularFiles(spaRoot)
    .filter((path) => path !== "manifest.json")
    .sort();
  const expectedPaths = Object.keys(manifest.entries).sort();

  for (const actualPath of actualPaths) {
    if (!isNormalizedSpaPath(actualPath)) {
      throw new Error(`SPA integrity rejected non-normalized path: ${actualPath}`);
    }
    if (!Object.hasOwn(manifest.entries, actualPath)) {
      throw new Error(`SPA integrity found extra file: ${actualPath}`);
    }
  }

  for (const expectedPath of expectedPaths) {
    if (!actualPaths.includes(expectedPath)) {
      throw new Error(`SPA integrity missing file: ${expectedPath}`);
    }
    verifyEntry(spaRoot, expectedPath, manifest.entries[expectedPath] as SpaManifestEntry);
  }

  return freezeManifest(manifest);
}

export function serializeCanonicalManifest(manifest: SpaManifest): string {
  const validationError = manifestValidationError(manifest);
  if (validationError) {
    throw new Error(`Invalid SPA manifest: ${validationError}`);
  }

  const sortedEntries = Object.fromEntries(
    Object.keys(manifest.entries)
      .sort(compareSpaPath)
      .map((path) => {
        const entry = manifest.entries[path] as SpaManifestEntry;
        return [
          path,
          {
            sha256: entry.sha256,
            mime: entry.mime,
            bytes: entry.bytes,
          },
        ];
      }),
  );
  return `${JSON.stringify({ version: 1, entries: sortedEntries }, null, 2)}\n`;
}

export function bundleIdForManifest(manifest: SpaManifest): string {
  return sha256Hex(serializeCanonicalManifest(manifest));
}

export function activeBundleRootFromSpaRoot(spaRoot: string, bundleId: string): string {
  if (!HASH_PATTERN.test(bundleId)) {
    throw new Error("Invalid SPA bundle id");
  }

  const absoluteSpaRoot = resolve(spaRoot);
  const bundlesRoot = join(absoluteSpaRoot, "bundles");
  const activeRoot = join(bundlesRoot, bundleId);
  const relativeActiveRoot = relative(bundlesRoot, activeRoot);
  if (relativeActiveRoot !== bundleId || isAbsolute(relativeActiveRoot)) {
    throw new Error("SPA active bundle root escaped the bundles directory");
  }

  assertExistingDirectory(absoluteSpaRoot, "SPA root");
  assertExistingDirectory(bundlesRoot, "SPA bundles root");
  assertExistingDirectory(activeRoot, "SPA active bundle root");
  return activeRoot;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareSpaPath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertExistingDirectory(path: string, label: string): void {
  const stat = lstatExisting(path, label);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }
}

function lstatExisting(path: string, label: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    throw error;
  }
}

function readRegularFileNoFollow(path: string, label: string): Buffer {
  const pathStat = lstatExisting(path, label);
  if (pathStat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!pathStat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  const descriptor = openRegularFileNoFollow(path, label);
  try {
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw new Error(`${label} changed while opening`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function openRegularFileNoFollow(path: string, label: string): number {
  try {
    return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    ) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    throw error;
  }
}

function manifestValidationError(value: unknown): string | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["entries", "version"])) {
      return "expected exact version and entries fields";
    }
    if (value.version !== 1 || !isRecord(value.entries)) {
      return "version must be 1 and entries must be an object";
    }

    for (const [path, entry] of Object.entries(value.entries)) {
      if (!isNormalizedSpaPath(path)) {
        return `non-normalized path: ${path}`;
      }
      const expectedMime = mimeFor(path);
      if (expectedMime === UNKNOWN_MIME) {
        return `unknown MIME for ${path}`;
      }
      if (!isRecord(entry) || !hasExactKeys(entry, ["bytes", "mime", "sha256"])) {
        return `invalid entry shape for ${path}`;
      }
      if (
        typeof entry.sha256 !== "string" ||
        !HASH_PATTERN.test(entry.sha256) ||
        entry.mime !== expectedMime ||
        typeof entry.bytes !== "number" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      ) {
        return `invalid metadata for ${path}`;
      }
    }
    return null;
  } catch {
    return "manifest fields could not be read";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function freezeManifest(manifest: SpaManifest): SpaManifest {
  const frozenEntries = Object.fromEntries(
    Object.entries(manifest.entries).map(([path, entry]) => [path, Object.freeze({ ...entry })]),
  ) as Readonly<Record<string, SpaManifestEntry>>;

  return Object.freeze({
    version: 1,
    entries: Object.freeze(frozenEntries),
  });
}

function listRegularFiles(spaRoot: string): string[] {
  const rootStat = lstatExisting(spaRoot, "SPA integrity root");
  if (rootStat.isSymbolicLink()) {
    throw new Error("SPA integrity rejected symlink root");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("SPA integrity root is not a directory");
  }

  const files: string[] = [];
  visitDirectory(spaRoot, spaRoot, files);
  return files;
}

function visitDirectory(spaRoot: string, directory: string, files: string[]): void {
  for (const name of readdirSync(directory).sort()) {
    const absolutePath = join(directory, name);
    const stat = lstatSync(absolutePath);
    const relativePath = relative(spaRoot, absolutePath).split(sep).join("/");

    if (stat.isSymbolicLink()) {
      throw new Error(`SPA integrity rejected symlink: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      visitDirectory(spaRoot, absolutePath, files);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`SPA integrity rejected non-regular file: ${relativePath}`);
    }
    files.push(relativePath);
  }
}

function verifyEntry(spaRoot: string, path: string, entry: SpaManifestEntry): void {
  const expectedMime = mimeFor(path);
  if (expectedMime === UNKNOWN_MIME) {
    throw new Error(`SPA integrity rejected unknown MIME for ${path}`);
  }

  const absolutePath = join(spaRoot, ...path.split("/"));
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`SPA integrity rejected non-regular file: ${path}`);
  }

  const content = readRegularFileNoFollow(absolutePath, `SPA asset ${path}`);
  const hash = sha256Hex(content);
  if (content.byteLength !== entry.bytes || expectedMime !== entry.mime || hash !== entry.sha256) {
    throw new Error(`SPA integrity mismatch for ${path}`);
  }
}
