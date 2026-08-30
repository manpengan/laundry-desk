import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import properLock from "proper-lockfile";
import { flushDirectoryDurably, replaceFileWriteThrough } from "@laundry/platform-fs";

const MANIFEST_FILE = "manifest.json";
const BUNDLES_DIRECTORY = "bundles";
const SHA256 = /^[0-9a-f]{64}$/u;
const DEFAULT_SOURCE_PATH = fileURLToPath(new URL("../../web/dist-spa/", import.meta.url));
const DEFAULT_TARGET_PATH = fileURLToPath(new URL("../resources/spa/", import.meta.url));
const MIME_BY_EXTENSION = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function comparePath(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error, ...codes) {
  return error instanceof Error && "code" in error && codes.includes(error.code);
}

function assertCanonicalKey(key) {
  const segments = key.split("/");
  const invalid =
    key.length === 0 ||
    key === MANIFEST_FILE ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("//") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    posix.normalize(key) !== key;
  if (invalid) {
    throw new Error("SPA path is not a canonical relative POSIX key");
  }
}

function mimeForKey(key) {
  const mime = MIME_BY_EXTENSION[extname(key)];
  if (mime === undefined) {
    throw new Error(`SPA asset has unknown MIME extension: ${key}`);
  }
  return mime;
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

function manifestEntry(key, content) {
  return Object.freeze({
    sha256: sha256Hex(content),
    mime: mimeForKey(key),
    bytes: content.byteLength,
  });
}

function canonicalManifest(files) {
  const sortedFiles = [...files].sort((left, right) => comparePath(left.key, right.key));
  const entries = Object.fromEntries(
    sortedFiles.map((file) => [file.key, manifestEntry(file.key, file.content)]),
  );
  return Object.freeze({
    version: 1,
    entries: Object.freeze(entries),
  });
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function bundleIdForManifest(manifest) {
  return sha256Hex(serializeManifest(manifest));
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertDirectory(path, label) {
  const metadata = await pathState(path);
  if (metadata === null) {
    throw new Error(`${label} directory is missing`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} directory must not be a symbolic link`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
}

async function readRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error(`${label} changed while opening`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function walkBundle(rootPath, relativeDirectory, files, skippedRootNames) {
  const directoryPath =
    relativeDirectory === "" ? rootPath : join(rootPath, ...relativeDirectory.split("/"));
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => comparePath(left.name, right.name));

  for (const entry of entries) {
    if (relativeDirectory === "" && skippedRootNames.has(entry.name)) continue;
    const key = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const filePath = join(rootPath, ...key.split("/"));
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `SPA ${entry.isDirectory() ? "directory" : "entry"} must not be a symbolic link: ${key}`,
      );
    }
    if (metadata.isDirectory()) {
      assertCanonicalKey(key);
      await walkBundle(rootPath, key, files, skippedRootNames);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`SPA entry must be a regular file: ${key}`);
    }

    assertCanonicalKey(key);
    const content = await readRegularFile(filePath, `SPA entry ${key}`);
    files.push(Object.freeze({ key, content }));
  }
}

async function readBundle(rootPath, label, skippedRootNames = new Set()) {
  await assertDirectory(rootPath, label);
  const files = [];
  await walkBundle(rootPath, "", files, skippedRootNames);
  if (!files.some((file) => file.key === "index.html")) {
    throw new Error(`${label} must contain index.html`);
  }
  return Object.freeze({
    files: Object.freeze(files),
    manifest: canonicalManifest(files),
  });
}

function parseManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SPA manifest is not valid JSON");
  }
  if (!isRecord(value) || !exactKeys(value, ["version", "entries"]) || value.version !== 1) {
    throw new Error("SPA manifest must have exact version 1 and entries fields");
  }
  if (!isRecord(value.entries)) {
    throw new Error("SPA manifest entries must be an object");
  }

  const keys = Object.keys(value.entries);
  const sortedKeys = [...keys].sort(comparePath);
  if (!keys.every((key, index) => key === sortedKeys[index])) {
    throw new Error("SPA manifest entries must be sorted");
  }
  for (const key of keys) {
    assertCanonicalKey(key);
    const entry = value.entries[key];
    if (!isRecord(entry) || !exactKeys(entry, ["sha256", "mime", "bytes"])) {
      throw new Error("SPA manifest entry has invalid fields");
    }
    if (
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256) ||
      entry.mime !== mimeForKey(key) ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    ) {
      throw new Error("SPA manifest entry has invalid integrity metadata");
    }
  }
  return value;
}

function assertManifestsEqual(actual, expected) {
  if (serializeManifest(actual) !== serializeManifest(expected)) {
    throw new Error("SPA drift detected");
  }
}

async function readCanonicalManifest(manifestPath) {
  const raw = await readRegularFile(manifestPath, "SPA manifest");
  const text = raw.toString("utf8");
  const manifest = parseManifest(text);
  if (text !== serializeManifest(manifest)) {
    throw new Error("SPA manifest is not canonical");
  }
  return Object.freeze({ raw, manifest, bundleId: sha256Hex(raw) });
}

async function verifyBundle(bundlePath, expectedManifest) {
  const bundle = await readBundle(bundlePath, "SPA bundle");
  assertManifestsEqual(bundle.manifest, expectedManifest);
  return bundle;
}

function resolvePaths(options = {}) {
  const sourcePath = resolve(options.sourcePath ?? DEFAULT_SOURCE_PATH);
  const targetPath = resolve(options.targetPath ?? DEFAULT_TARGET_PATH);
  const sourceToTarget = relative(sourcePath, targetPath);
  const targetToSource = relative(targetPath, sourcePath);
  const overlaps =
    sourcePath === targetPath ||
    (sourceToTarget !== "" && !sourceToTarget.startsWith("..") && !isAbsolute(sourceToTarget)) ||
    (targetToSource !== "" && !targetToSource.startsWith("..") && !isAbsolute(targetToSource));
  if (overlaps) {
    throw new Error("SPA source and target directories must not overlap");
  }
  return Object.freeze({ sourcePath, targetPath });
}

async function reportFsync(dependencies, event) {
  await dependencies.afterFsync?.(Object.freeze(event));
}

async function fsyncDirectory(directoryPath, dependencies, report = true) {
  await flushDirectoryDurably(directoryPath);
  if (report) await reportFsync(dependencies, { kind: "directory", path: directoryPath });
}

async function writeDurableFile(filePath, content, mode, dependencies, report = true) {
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (report) await reportFsync(dependencies, { kind: "file", path: filePath });
}

async function ensureTargetRoot(targetPath, dependencies) {
  const parentPath = dirname(targetPath);
  await assertDirectory(parentPath, "SPA target parent");
  const metadata = await pathState(targetPath);
  if (metadata?.isSymbolicLink() === true) {
    throw new Error("SPA target must not be a symbolic link");
  }
  if (metadata !== null && !metadata.isDirectory()) {
    throw new Error("SPA target must be a directory");
  }
  if (metadata === null) {
    await mkdir(targetPath, { mode: 0o755 });
    await fsyncDirectory(parentPath, dependencies);
  }
}

async function ensureBundlesRoot(targetPath, dependencies) {
  const bundlesPath = join(targetPath, BUNDLES_DIRECTORY);
  const metadata = await pathState(bundlesPath);
  if (metadata?.isSymbolicLink() === true) {
    throw new Error("SPA bundles directory must not be a symbolic link");
  }
  if (metadata !== null && !metadata.isDirectory()) {
    throw new Error("SPA bundles path must be a directory");
  }
  if (metadata === null) {
    await mkdir(bundlesPath, { mode: 0o755 });
    await fsyncDirectory(targetPath, dependencies);
  }
  return bundlesPath;
}

async function inspectCurrentTarget(targetPath, dependencies) {
  const manifestPath = join(targetPath, MANIFEST_FILE);
  if ((await pathState(manifestPath)) === null) {
    await recoverUnpointedTarget(targetPath, dependencies);
    return Object.freeze({
      kind: "empty",
      activeBundleId: null,
    });
  }

  const pointer = await readCanonicalManifest(manifestPath);
  const activeBundlePath = join(targetPath, BUNDLES_DIRECTORY, pointer.bundleId);
  const activeMetadata = await pathState(activeBundlePath);
  if (activeMetadata !== null) {
    if (activeMetadata.isSymbolicLink() || !activeMetadata.isDirectory()) {
      throw new Error("SPA active bundle must be a regular directory");
    }
    await verifyBundle(activeBundlePath, pointer.manifest);
    return Object.freeze({
      kind: "versioned",
      activeBundleId: pointer.bundleId,
    });
  }

  const legacy = await readBundle(
    targetPath,
    "SPA legacy target",
    new Set([MANIFEST_FILE, BUNDLES_DIRECTORY]),
  );
  assertManifestsEqual(legacy.manifest, pointer.manifest);
  return Object.freeze({
    kind: "legacy",
    activeBundleId: null,
  });
}

async function recoverUnpointedTarget(targetPath, dependencies) {
  const manifestTemporaryPrefix = `.${MANIFEST_FILE}.tmp-`;
  let bundlesPath = null;
  let changed = false;
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    const entryPath = join(targetPath, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Unpointed SPA target entry must not be a symbolic link: ${entry.name}`);
    }
    if (entry.name === BUNDLES_DIRECTORY && metadata.isDirectory()) {
      bundlesPath = entryPath;
      continue;
    }
    if (entry.name.startsWith(manifestTemporaryPrefix) && metadata.isFile()) {
      await rm(entryPath, { force: true });
      changed = true;
      continue;
    }
    throw new Error(`SPA target without a manifest contains an unmanaged entry: ${entry.name}`);
  }

  if (bundlesPath !== null) {
    for (const entry of await readdir(bundlesPath, { withFileTypes: true })) {
      const bundlePath = join(bundlesPath, entry.name);
      const metadata = await lstat(bundlePath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Unpointed SPA bundle must be a regular directory: ${entry.name}`);
      }
      if (entry.name.startsWith(".tmp-")) {
        await rm(bundlePath, { force: true, recursive: true });
        changed = true;
        continue;
      }
      if (!SHA256.test(entry.name)) {
        throw new Error(`Unpointed SPA target contains an invalid bundle id: ${entry.name}`);
      }
      const bundle = await readBundle(bundlePath, `Unpointed SPA bundle ${entry.name}`);
      if (bundleIdForManifest(bundle.manifest) !== entry.name) {
        throw new Error(`Unpointed SPA bundle content does not match its id: ${entry.name}`);
      }
    }
    if (changed) await fsyncDirectory(bundlesPath, dependencies);
  }
  if (changed) await fsyncDirectory(targetPath, dependencies);
}

async function writeTemporaryBundle(temporaryPath, bundle, dependencies) {
  const directories = new Set([temporaryPath]);
  for (const file of bundle.files) {
    let directoryPath = dirname(join(temporaryPath, ...file.key.split("/")));
    const pending = [];
    while (directoryPath !== temporaryPath) {
      pending.push(directoryPath);
      directoryPath = dirname(directoryPath);
    }
    for (const path of pending.reverse()) {
      if (!directories.has(path)) {
        await mkdir(path, { mode: 0o755 });
        directories.add(path);
      }
    }
  }

  for (const file of bundle.files) {
    const filePath = join(temporaryPath, ...file.key.split("/"));
    await writeDurableFile(filePath, file.content, 0o644, dependencies);
  }
  for (const directoryPath of [...directories].sort((left, right) => right.length - left.length)) {
    await fsyncDirectory(directoryPath, dependencies);
  }
}

async function installBundle(targetPath, bundle, dependencies) {
  const bundlesPath = await ensureBundlesRoot(targetPath, dependencies);
  const bundleId = bundleIdForManifest(bundle.manifest);
  const finalPath = join(bundlesPath, bundleId);
  const finalMetadata = await pathState(finalPath);
  if (finalMetadata !== null) {
    if (finalMetadata.isSymbolicLink() || !finalMetadata.isDirectory()) {
      throw new Error("Existing SPA bundle must be a regular directory");
    }
    await verifyBundle(finalPath, bundle.manifest);
    return Object.freeze({ bundleId, bundlePath: finalPath, installed: false });
  }

  const temporaryPath = join(bundlesPath, `.tmp-${bundleId}-${randomUUID()}`);
  await mkdir(temporaryPath, { mode: 0o755 });
  let installed = false;
  try {
    await writeTemporaryBundle(temporaryPath, bundle, dependencies);
    await verifyBundle(temporaryPath, bundle.manifest);
    const renamePath = dependencies.renamePath ?? rename;
    try {
      await renamePath(temporaryPath, finalPath);
      installed = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST", "ENOTEMPTY")) throw error;
      await verifyBundle(finalPath, bundle.manifest);
    }
    await fsyncDirectory(bundlesPath, dependencies);
  } finally {
    await rm(temporaryPath, { force: true, recursive: true });
  }
  return Object.freeze({ bundleId, bundlePath: finalPath, installed });
}

async function commitManifest(targetPath, manifest, dependencies, onCommitted) {
  const manifestPath = join(targetPath, MANIFEST_FILE);
  const temporaryPath = join(targetPath, `.${MANIFEST_FILE}.tmp-${randomUUID()}`);
  const serialized = serializeManifest(manifest);
  try {
    await writeDurableFile(temporaryPath, serialized, 0o644, dependencies);
    const verified = await readCanonicalManifest(temporaryPath);
    assertManifestsEqual(verified.manifest, manifest);
    if (verified.bundleId !== bundleIdForManifest(manifest)) {
      throw new Error("SPA temporary manifest bundle id changed");
    }
    await dependencies.beforeManifestCommit?.();
    const replacePath = dependencies.renamePath ?? replaceFileWriteThrough;
    await replacePath(temporaryPath, manifestPath);
    onCommitted();
    await dependencies.afterManifestRename?.();
    await fsyncDirectory(targetPath, dependencies);
    await dependencies.afterManifestCommit?.();
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function cleanupAfterCommit(targetPath, dependencies) {
  const rootEntries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === MANIFEST_FILE || entry.name === BUNDLES_DIRECTORY) continue;
    await rm(join(targetPath, entry.name), { force: true, recursive: true });
  }

  const bundlesPath = join(targetPath, BUNDLES_DIRECTORY);
  const bundleEntries = await readdir(bundlesPath, { withFileTypes: true });
  for (const entry of bundleEntries) {
    const bundlePath = join(bundlesPath, entry.name);
    const metadata = await lstat(bundlePath);
    if (!SHA256.test(entry.name) || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      await rm(bundlePath, { force: true, recursive: true });
      continue;
    }
    const bundle = await readBundle(bundlePath, `SPA retained bundle ${entry.name}`);
    if (bundleIdForManifest(bundle.manifest) !== entry.name) {
      await rm(bundlePath, { force: true, recursive: true });
    }
  }
  await fsyncDirectory(bundlesPath, dependencies);
  await fsyncDirectory(targetPath, dependencies);
}

async function removeInstalledCandidate(installation, dependencies) {
  if (!installation.installed) return;
  await rm(installation.bundlePath, { force: true, recursive: true });
  await fsyncDirectory(dirname(installation.bundlePath), dependencies);
}

async function withPublicationLock(targetPath, dependencies, operation) {
  const parentPath = dirname(targetPath);
  const lockPath = join(parentPath, ".spa.sync.lock");
  const stale = dependencies.lockStaleMs ?? 30_000;
  let release;
  try {
    release = await properLock(targetPath, {
      lockfilePath: lockPath,
      realpath: false,
      retries: 0,
      stale,
      update: dependencies.lockUpdateMs ?? Math.max(1_000, Math.floor(stale / 2)),
    });
  } catch (error) {
    if (isErrorCode(error, "ELOCKED")) {
      throw new Error(`SPA sync lock is already held: ${lockPath}`);
    }
    throw error;
  }

  let result;
  let failure;
  try {
    await dependencies.afterLockAcquired?.(lockPath);
    result = await operation();
  } catch (error) {
    failure = error;
  }

  const cleanupErrors = [];
  try {
    await release();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (failure !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupErrors],
        "SPA operation and lock cleanup failed",
      );
    }
    throw failure;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "SPA lock cleanup failed");
  }
  return result;
}

async function validateManagedRootShape(targetPath) {
  const entries = await readdir(targetPath, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(comparePath);
  if (names.length !== 2 || names[0] !== BUNDLES_DIRECTORY || names[1] !== MANIFEST_FILE) {
    throw new Error("SPA target contains a stale bundle or legacy root asset");
  }
  for (const entry of entries) {
    const path = join(targetPath, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`SPA target entry must not be a symbolic link: ${entry.name}`);
    }
    if (entry.name === BUNDLES_DIRECTORY && !metadata.isDirectory()) {
      throw new Error("SPA bundles path must be a directory");
    }
    if (entry.name === MANIFEST_FILE && !metadata.isFile()) {
      throw new Error("SPA manifest must be a regular file");
    }
  }
}

async function verifyManagedBundles(targetPath, activeBundleId, activeManifest) {
  const bundlesPath = join(targetPath, BUNDLES_DIRECTORY);
  await assertDirectory(bundlesPath, "SPA bundles");
  const entries = await readdir(bundlesPath, { withFileTypes: true });
  if (entries.length < 1) throw new Error("SPA active bundle is missing");

  let foundActive = false;
  for (const entry of entries) {
    if (!SHA256.test(entry.name)) {
      throw new Error(`SPA target contains a stale bundle: ${entry.name}`);
    }
    const bundlePath = join(bundlesPath, entry.name);
    const metadata = await lstat(bundlePath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`SPA bundle must be a regular directory: ${entry.name}`);
    }
    const bundle = await readBundle(bundlePath, `SPA bundle ${entry.name}`);
    if (bundleIdForManifest(bundle.manifest) !== entry.name) {
      throw new Error(`SPA drift detected in bundle ${entry.name}`);
    }
    if (entry.name === activeBundleId) {
      foundActive = true;
      assertManifestsEqual(bundle.manifest, activeManifest);
    }
  }
  if (!foundActive) throw new Error("SPA active bundle is missing");
}

export async function checkSpa(options = {}) {
  const { sourcePath, targetPath } = resolvePaths(options);
  const sourceBundle = await readBundle(sourcePath, "SPA source", new Set([MANIFEST_FILE]));
  await assertDirectory(targetPath, "SPA target");
  await validateManagedRootShape(targetPath);
  const pointer = await readCanonicalManifest(join(targetPath, MANIFEST_FILE));
  assertManifestsEqual(pointer.manifest, sourceBundle.manifest);
  await verifyManagedBundles(targetPath, pointer.bundleId, pointer.manifest);
  return Object.freeze({ entries: Object.keys(sourceBundle.manifest.entries).length });
}

export async function syncSpa(options = {}, dependencies = {}) {
  const { sourcePath, targetPath } = resolvePaths(options);
  const sourceBundle = await readBundle(sourcePath, "SPA source", new Set([MANIFEST_FILE]));
  await ensureTargetRoot(targetPath, dependencies);

  return withPublicationLock(targetPath, dependencies, async () => {
    await inspectCurrentTarget(targetPath, dependencies);
    const installation = await installBundle(targetPath, sourceBundle, dependencies);
    let committed = false;
    try {
      await commitManifest(targetPath, sourceBundle.manifest, dependencies, () => {
        committed = true;
      });
    } catch (error) {
      if (!committed) await removeInstalledCandidate(installation, dependencies);
      throw error;
    }

    await cleanupAfterCommit(targetPath, dependencies);
    return Object.freeze({ entries: Object.keys(sourceBundle.manifest.entries).length });
  });
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

async function runCli(argv) {
  if (argv.length !== 1 || (argv[0] !== "sync" && argv[0] !== "check")) {
    throw new Error("usage: sync-spa.mjs <sync|check>");
  }
  const result = argv[0] === "sync" ? await syncSpa() : await checkSpa();
  process.stdout.write(`SPA_${argv[0].toUpperCase()}_OK entries=${result.entries}\n`);
}

if (isMainModule()) {
  void runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "SPA operation failed"}\n`);
    process.exitCode = 1;
  });
}
