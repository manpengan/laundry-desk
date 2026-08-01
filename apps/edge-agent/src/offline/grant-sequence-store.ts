import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const GrantSequenceEntrySchema = z
  .strictObject({
    grant_id: z.uuid(),
    high_water: PositiveSafeIntegerSchema,
    pending: PositiveSafeIntegerSchema.nullable(),
  })
  .refine((entry) => entry.pending === null || entry.pending === entry.high_water, {
    message: "Pending grant sequence must equal its high-water",
    path: ["pending"],
  });
const GrantSequenceFileSchema = z
  .strictObject({
    version: z.literal(1),
    grants: z.array(GrantSequenceEntrySchema).max(10_000),
  })
  .refine(
    (state) => new Set(state.grants.map((entry) => entry.grant_id)).size === state.grants.length,
    {
      message: "Grant sequence ids must be unique",
      path: ["grants"],
    },
  );

type GrantSequenceEntry = Readonly<z.output<typeof GrantSequenceEntrySchema>>;
type GrantSequenceState = Readonly<{
  version: 1;
  grants: readonly GrantSequenceEntry[];
}>;

export interface GrantSequenceStore {
  /** Durably consumes the next number before a queue append may begin. */
  reserve(grantId: string): number;
  /** Marks the reservation complete only after the encrypted envelope is durable. */
  commit(grantId: string, sequence: number): void;
}

const EMPTY_STATE: GrantSequenceState = Object.freeze({ version: 1, grants: Object.freeze([]) });

function freezeState(input: unknown): GrantSequenceState {
  const parsed = GrantSequenceFileSchema.parse(input);
  return Object.freeze({
    version: 1,
    grants: Object.freeze(parsed.grants.map((entry) => Object.freeze({ ...entry }))),
  });
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Grant sequence state escaped its private root");
  }
}

function preparePrivateRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Grant sequence root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Grant sequence root must be a real directory");
  }
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function replaceEntry(
  state: GrantSequenceState,
  nextEntry: GrantSequenceEntry,
): GrantSequenceState {
  const grants = [
    ...state.grants.filter((entry) => entry.grant_id !== nextEntry.grant_id),
    nextEntry,
  ];
  return freezeState({ version: 1, grants });
}

/**
 * Durable two-phase high-water. A crash between reserve and queue append leaves
 * `pending` set, permanently failing that grant closed instead of reusing a seq.
 */
export class FileGrantSequenceStore implements GrantSequenceStore {
  private readonly root: string;
  private readonly path: string;
  private snapshot: GrantSequenceState;

  constructor(rootPath: string) {
    this.root = preparePrivateRoot(rootPath);
    this.path = join(this.root, "offline-grant-sequences.json");
    assertContained(this.root, this.path);
    this.snapshot = this.readCurrent();
  }

  reserve(grantIdInput: string): number {
    const grantId = z.uuid().parse(grantIdInput);
    const current = this.readCurrent();
    this.assertNotRolledBack(current);
    const existing = current.grants.find((entry) => entry.grant_id === grantId);
    if (existing?.pending !== null && existing?.pending !== undefined) {
      throw new Error("Grant sequence has a pending reservation; authority is fail-closed");
    }
    const highWater = existing?.high_water ?? 0;
    if (highWater >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Grant sequence high-water is exhausted");
    }
    const sequence = highWater + 1;
    const next = replaceEntry(
      current,
      Object.freeze({ grant_id: grantId, high_water: sequence, pending: sequence }),
    );
    this.atomicWrite(next);
    this.snapshot = next;
    return sequence;
  }

  commit(grantIdInput: string, sequenceInput: number): void {
    const grantId = z.uuid().parse(grantIdInput);
    const sequence = PositiveSafeIntegerSchema.parse(sequenceInput);
    const current = this.readCurrent();
    this.assertNotRolledBack(current);
    const existing = current.grants.find((entry) => entry.grant_id === grantId);
    if (existing?.high_water !== sequence || existing.pending !== sequence) {
      throw new Error("Grant sequence commit does not match its pending reservation");
    }
    const next = replaceEntry(
      current,
      Object.freeze({ grant_id: grantId, high_water: sequence, pending: null }),
    );
    this.atomicWrite(next);
    this.snapshot = next;
  }

  private readCurrent(): GrantSequenceState {
    let fd: number | null = null;
    try {
      try {
        fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
        throw error;
      }
      const before = fstatSync(fd);
      const pathBefore = lstatSync(this.path);
      if (
        !this.validStateMetadata(pathBefore) ||
        !this.validStateMetadata(before) ||
        !this.sameSnapshot(pathBefore, before)
      ) {
        throw new Error("Invalid offline grant sequence file");
      }
      const content = readFileSync(fd, "utf8");
      const after = fstatSync(fd);
      const pathAfter = lstatSync(this.path);
      if (
        Buffer.byteLength(content, "utf8") !== before.size ||
        !this.validStateMetadata(after) ||
        !this.validStateMetadata(pathAfter) ||
        !this.sameSnapshot(before, after) ||
        !this.sameSnapshot(after, pathAfter)
      ) {
        throw new Error("Invalid offline grant sequence file");
      }
      return freezeState(JSON.parse(content) as unknown);
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid offline grant sequence file") {
        throw error;
      }
      throw new Error("Invalid offline grant sequence file", { cause: error });
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  private validStateMetadata(meta: Stats): boolean {
    return (
      meta.isFile() &&
      !meta.isSymbolicLink() &&
      meta.nlink === 1 &&
      (meta.mode & 0o777) === 0o600 &&
      meta.size > 0 &&
      meta.size <= 2 * 1_024 * 1_024
    );
  }

  private sameSnapshot(
    left: Pick<Stats, "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs">,
    right: Pick<Stats, "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs">,
  ): boolean {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.nlink === right.nlink &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
    );
  }

  private assertNotRolledBack(current: GrantSequenceState): void {
    for (const previous of this.snapshot.grants) {
      const observed = current.grants.find((entry) => entry.grant_id === previous.grant_id);
      if (observed === undefined || observed.high_water < previous.high_water) {
        throw new Error("Offline grant sequence rollback detected");
      }
      if (
        observed.high_water === previous.high_water &&
        previous.pending === null &&
        observed.pending !== null
      ) {
        throw new Error("Offline grant sequence commit rollback detected");
      }
    }
  }

  private atomicWrite(state: GrantSequenceState): void {
    const staging = join(
      this.root,
      `.offline-grant-sequences.${randomBytes(12).toString("hex")}.staging`,
    );
    assertContained(this.root, staging);
    const fd = openSync(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let failure: unknown = null;
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
    } catch (error) {
      failure = error;
    } finally {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) {
      try {
        unlinkSync(staging);
      } finally {
        this.syncRoot();
      }
      throw failure;
    }
    try {
      renameSync(staging, this.path);
    } catch (error) {
      try {
        unlinkSync(staging);
      } finally {
        this.syncRoot();
      }
      throw error;
    }
    this.syncRoot();
  }

  private syncRoot(): void {
    const fd = openSync(this.root, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
