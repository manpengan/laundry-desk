/**
 * Local-only file spool for the mock printer (product design §7).
 *
 * Security posture, all enforced here rather than by the caller:
 *   - the spool root is canonicalised once and every write must land inside it;
 *   - the artifact name is derived only from a validated job id, kind and
 *     sequence — no caller-supplied path ever reaches the filesystem;
 *   - directories are 0700 and files 0600, and a symlink anywhere on the path
 *     is refused rather than followed;
 *   - install is atomic and no-replace: write a temp file, fsync it, hard-link
 *     it into place (link fails if the target exists), then unlink the temp;
 *   - re-running a job is idempotent only when the bytes match. An existing
 *     artifact with different content fails closed instead of being silently
 *     overwritten.
 *
 * No shell is spawned and no caller-supplied template is executed.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  flushDirectoryDurably,
  inspectPrivateDirectory,
  inspectPrivateFile,
  securePrivateDirectory,
  securePrivateFile,
} from "@laundry/platform-fs";

import type { PrintJobKind } from "./types.js";

/** One artifact may not exceed this; a runaway render must not fill the disk. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024;

/** Whole-spool budget. Retention evicts oldest-first to stay under it. */
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Retention count, so a small-artifact workload cannot grow unbounded either. */
export const DEFAULT_MAX_ARTIFACTS = 500;

/** Only files the spool itself produced are ever eligible for eviction. */
const ARTIFACT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-z0-9]{1,16}-[0-9]{4}\.txt$/u;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KINDS: ReadonlySet<string> = new Set(["xp58", "dl206", "gp3120"]);
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type FileSpoolOptions = Readonly<{
  rootPath: string;
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
  maxArtifacts?: number;
}>;

export type SpoolArtifact = Readonly<{
  /** Path relative to the spool root; never absolute, never traversing. */
  relative_path: string;
  sha256: string;
  bytes: number;
  /** True when an identical artifact already existed and was reused. */
  reused: boolean;
}>;

export type FileSpool = Readonly<{
  rootPath: string;
  write: (input: SpoolWriteInput) => Promise<SpoolArtifact>;
  /** Evict oldest artifacts until the spool is inside its count and byte caps. */
  sweep: () => Promise<SpoolSweepResult>;
}>;

export type SpoolSweepResult = Readonly<{
  removed: number;
  removed_bytes: number;
  retained: number;
  retained_bytes: number;
}>;

export type SpoolWriteInput = Readonly<{
  job_id: string;
  kind: PrintJobKind;
  /** Attempt sequence; keeps retries of the same job distinguishable. */
  seq: number;
  content: string;
}>;

export class SpoolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SpoolError";
    this.code = code;
  }
}

function assertContained(rootPath: string, candidate: string): void {
  const rel = relative(rootPath, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SpoolError("SPOOL_PATH_ESCAPE", "artifact path escaped the spool root");
  }
}

/** Refuse a symlinked root outright; following it would leave the sandbox. */
async function assertRealDirectory(path: string): Promise<void> {
  const meta = await lstat(path);
  if (meta.isSymbolicLink()) {
    throw new SpoolError("SPOOL_ROOT_SYMLINK", "spool root must not be a symbolic link");
  }
  if (!meta.isDirectory()) {
    throw new SpoolError("SPOOL_ROOT_NOT_DIRECTORY", "spool root must be a directory");
  }
}

function artifactName(input: SpoolWriteInput): string {
  if (!UUID.test(input.job_id)) {
    throw new SpoolError("SPOOL_BAD_JOB_ID", "artifact name requires a validated job id");
  }
  if (!KINDS.has(input.kind)) {
    throw new SpoolError("SPOOL_BAD_KIND", "artifact name requires a known printer kind");
  }
  if (!Number.isInteger(input.seq) || input.seq < 1 || input.seq > 9_999) {
    throw new SpoolError("SPOOL_BAD_SEQ", "artifact sequence must be 1..9999");
  }
  return `${input.job_id}-${input.kind}-${String(input.seq).padStart(4, "0")}.txt`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write + fsync a private temp file next to its final name, then return it. */
async function stageTemp(directory: string, name: string, bytes: Buffer): Promise<string> {
  const tempPath = join(directory, `.${name}.staging`);
  await rm(tempPath, { force: true });
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    await securePrivateFile(tempPath);
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await inspectPrivateFile(tempPath);
  return tempPath;
}

/**
 * An artifact already exists. Reuse it only if the bytes are identical —
 * differing content means two renders disagree about the same job, which must
 * surface rather than be papered over.
 */
async function reuseOrFail(
  finalPath: string,
  expectedHash: string,
  bytes: number,
  relativePath: string,
): Promise<SpoolArtifact> {
  const meta = await lstat(finalPath);
  if (meta.isSymbolicLink()) {
    throw new SpoolError("SPOOL_ARTIFACT_SYMLINK", "existing artifact is a symbolic link");
  }
  try {
    await inspectPrivateFile(finalPath);
  } catch {
    throw new SpoolError("SPOOL_ARTIFACT_SECURITY", "existing artifact is not private");
  }
  const existing = await readFile(finalPath);
  if (sha256Hex(existing) !== expectedHash) {
    throw new SpoolError("SPOOL_ARTIFACT_CONFLICT", "existing artifact has different content");
  }
  return Object.freeze({ relative_path: relativePath, sha256: expectedHash, bytes, reused: true });
}

type SpoolEntry = Readonly<{ name: string; bytes: number; mtimeMs: number }>;

/**
 * List only files this spool produced. Anything else in the directory — a
 * stray file, a symlink someone planted, a leftover staging file — is ignored
 * rather than considered for deletion, so retention can never remove something
 * it does not own.
 */
async function listArtifacts(rootPath: string): Promise<readonly SpoolEntry[]> {
  const names = await readdir(rootPath);
  const entries: SpoolEntry[] = [];
  for (const name of names) {
    if (!ARTIFACT_NAME.test(name)) continue;
    const meta = await lstat(join(rootPath, name)).catch(() => null);
    if (meta === null || meta.isSymbolicLink() || !meta.isFile()) continue;
    if ((await inspectPrivateFile(join(rootPath, name)).catch(() => null)) === null) continue;
    entries.push({ name, bytes: meta.size, mtimeMs: meta.mtimeMs });
  }
  return Object.freeze(entries);
}

/**
 * Evict oldest-first until both caps hold. Retention is best-effort against a
 * concurrent writer: a file that vanished under us is simply skipped.
 */
async function sweepSpool(
  rootPath: string,
  maxTotalBytes: number,
  maxArtifacts: number,
): Promise<SpoolSweepResult> {
  const entries = [...(await listArtifacts(rootPath))].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let count = entries.length;
  let removed = 0;
  let removedBytes = 0;

  for (const entry of entries) {
    if (count <= maxArtifacts && total <= maxTotalBytes) break;
    try {
      await unlink(join(rootPath, entry.name));
    } catch {
      continue;
    }
    removed += 1;
    removedBytes += entry.bytes;
    total -= entry.bytes;
    count -= 1;
  }
  if (removed > 0) await flushDirectoryDurably(rootPath);
  return Object.freeze({
    removed,
    removed_bytes: removedBytes,
    retained: count,
    retained_bytes: total,
  });
}

export async function createFileSpool(options: FileSpoolOptions): Promise<FileSpool> {
  if (!isAbsolute(options.rootPath)) {
    throw new SpoolError("SPOOL_ROOT_RELATIVE", "spool root must be an absolute path");
  }
  const maxBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxArtifacts = options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
  await mkdir(options.rootPath, { recursive: true, mode: DIR_MODE });
  await assertRealDirectory(options.rootPath);
  // Canonicalise once so later containment checks compare real paths.
  const rootPath = await realpath(resolve(options.rootPath));
  await securePrivateDirectory(rootPath);
  await inspectPrivateDirectory(rootPath);

  return Object.freeze({
    rootPath,
    sweep: (): Promise<SpoolSweepResult> => sweepSpool(rootPath, maxTotalBytes, maxArtifacts),
    write: async (input: SpoolWriteInput): Promise<SpoolArtifact> => {
      const bytes = Buffer.from(input.content, "utf8");
      if (bytes.byteLength > maxBytes) {
        throw new SpoolError("SPOOL_ARTIFACT_TOO_LARGE", "artifact exceeds the per-job byte cap");
      }
      const name = artifactName(input);
      const finalPath = join(rootPath, name);
      assertContained(rootPath, finalPath);
      const hash = sha256Hex(bytes);

      // Make room before installing, so the artifact just rendered is never
      // the one evicted to satisfy the cap.
      await sweepSpool(rootPath, Math.max(0, maxTotalBytes - bytes.byteLength), maxArtifacts - 1);

      const tempPath = await stageTemp(rootPath, name, bytes);
      try {
        // link() refuses to clobber an existing target, which is exactly the
        // no-replace install the spec asks for.
        await link(tempPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          await rm(tempPath, { force: true });
          return await reuseOrFail(finalPath, hash, bytes.byteLength, name);
        }
        await rm(tempPath, { force: true });
        throw error;
      }
      await unlink(tempPath);
      await inspectPrivateFile(finalPath);
      await flushDirectoryDurably(rootPath);
      return Object.freeze({
        relative_path: name,
        sha256: hash,
        bytes: bytes.byteLength,
        reused: false,
      });
    },
  });
}
