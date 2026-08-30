import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  CommandErrorCodeSchema,
  DesktopCommandNameSchema,
  type CommandErrorCode,
  type DesktopCommandName,
} from "@laundry/contracts";
import {
  flushDirectoryDurablySync,
  inspectPrivateDirectorySync,
  inspectPrivateFileSync,
  replaceFileWriteThroughSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "@laundry/platform-fs";
import { z } from "zod";

const ConflictFileSchema = z.strictObject({
  version: z.literal(1),
  conflicts: z
    .array(
      z.strictObject({
        queue_id: z.uuid(),
        command: DesktopCommandNameSchema,
        error_code: CommandErrorCodeSchema,
        created_at: z.iso.datetime({ offset: true }),
      }),
    )
    .max(1_000),
});

export type OfflineConflict = Readonly<{
  queue_id: string;
  command: DesktopCommandName;
  error_code: CommandErrorCode;
  created_at: string;
}>;

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Offline conflict file escaped its private root");
  }
}

function decode(value: unknown): readonly OfflineConflict[] {
  const parsed = ConflictFileSchema.parse(value);
  if (new Set(parsed.conflicts.map((entry) => entry.queue_id)).size !== parsed.conflicts.length) {
    throw new Error("Offline conflict ids must be unique");
  }
  return Object.freeze(parsed.conflicts.map((entry) => Object.freeze({ ...entry })));
}

export class OfflineConflictStore {
  private readonly root: string;
  private readonly path: string;
  private conflicts: readonly OfflineConflict[];

  constructor(rootPath: string) {
    if (!isAbsolute(rootPath)) throw new Error("Offline conflict root must be absolute");
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    const rootMetadata = lstatSync(rootPath);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("Offline conflict root must be a real directory");
    }
    securePrivateDirectorySync(rootPath);
    this.root = realpathSync(rootPath);
    inspectPrivateDirectorySync(this.root);
    this.path = join(this.root, "offline-conflicts.json");
    assertContained(this.root, this.path);
    if (!existsSync(this.path)) {
      this.conflicts = Object.freeze([]);
      return;
    }
    const meta = lstatSync(this.path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 512 * 1_024) {
      throw new Error("Invalid offline conflict file");
    }
    inspectPrivateFileSync(this.path);
    this.conflicts = decode(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
  }

  list(): readonly OfflineConflict[] {
    return this.conflicts;
  }

  has(queueId: string): boolean {
    return this.conflicts.some((entry) => entry.queue_id === queueId);
  }

  put(conflict: OfflineConflict): void {
    const next = [
      ...this.conflicts.filter((entry) => entry.queue_id !== conflict.queue_id),
      Object.freeze({ ...conflict }),
    ];
    this.persist(next);
  }

  remove(queueId: string): boolean {
    if (!this.has(queueId)) return false;
    this.persist(this.conflicts.filter((entry) => entry.queue_id !== queueId));
    return true;
  }

  clear(): void {
    this.conflicts = Object.freeze([]);
    if (existsSync(this.path)) {
      inspectPrivateFileSync(this.path);
      unlinkSync(this.path);
      flushDirectoryDurablySync(this.root);
    }
  }

  private persist(conflicts: readonly OfflineConflict[]): void {
    const parsed = ConflictFileSchema.parse({ version: 1, conflicts });
    const temp = join(this.root, `.offline-conflicts.${randomBytes(12).toString("hex")}.staging`);
    assertContained(this.root, temp);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      securePrivateFileSync(temp);
      writeFileSync(fd, `${JSON.stringify(parsed)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      replaceFileWriteThroughSync(temp, this.path);
    } catch (error) {
      unlinkSync(temp);
      flushDirectoryDurablySync(this.root);
      throw error;
    }
    flushDirectoryDurablySync(this.root);
    this.conflicts = decode(parsed);
  }
}
