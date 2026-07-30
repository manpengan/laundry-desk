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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

import type { QueueRowState, QueueStore, QueueStoredRecord } from "./store.js";

const QueueFileSchema = z
  .strictObject({
    version: z.literal(1),
    rows: z
      .array(
        z.strictObject({
          id: z.uuid(),
          seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          sealed_payload: z.base64(),
          aad: z.string().min(1).max(512),
          state: z.enum(["pending", "inflight"]),
        }),
      )
      .max(10_000),
  })
  .superRefine((file, context) => {
    if (new Set(file.rows.map((row) => row.id)).size !== file.rows.length) {
      context.addIssue({ code: "custom", message: "Queue ids must be unique" });
    }
    if (new Set(file.rows.map((row) => row.seq)).size !== file.rows.length) {
      context.addIssue({ code: "custom", message: "Queue sequence values must be unique" });
    }
  });

type StoredRow = Readonly<QueueStoredRecord & { state: QueueRowState }>;

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Queue file escaped its private root");
  }
}

function prepareRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("Queue root must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error("Queue root must be a real directory");
  }
  return realpathSync(path);
}

function decodeRows(value: unknown): readonly StoredRow[] {
  const file = QueueFileSchema.parse(value);
  return Object.freeze(
    file.rows.map((row) =>
      Object.freeze({
        id: row.id,
        seq: row.seq,
        sealedPayload: Buffer.from(row.sealed_payload, "base64"),
        aad: row.aad,
        state: row.state,
      }),
    ),
  );
}

function encodeRows(rows: readonly StoredRow[]): z.input<typeof QueueFileSchema> {
  return {
    version: 1,
    rows: rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      sealed_payload: row.sealedPayload.toString("base64"),
      aad: row.aad,
      state: row.state,
    })),
  };
}

export class FileQueueStore implements QueueStore {
  private readonly root: string;
  private readonly path: string;
  private rows: readonly StoredRow[];

  constructor(rootPath: string) {
    this.root = prepareRoot(rootPath);
    this.path = join(this.root, "offline-queue.json");
    assertContained(this.root, this.path);
    if (!existsSync(this.path)) {
      this.rows = Object.freeze([]);
      return;
    }
    const meta = lstatSync(this.path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 16 * 1024 * 1024) {
      throw new Error("Invalid offline queue file");
    }
    this.rows = decodeRows(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
  }

  private persist(rows: readonly StoredRow[]): void {
    const parsed = QueueFileSchema.parse(encodeRows(rows));
    const temp = join(this.root, ".offline-queue.staging");
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(parsed)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    const dirFd = openSync(this.root, constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    this.rows = decodeRows(parsed);
  }

  append(record: QueueStoredRecord): void {
    if (this.rows.some((row) => row.id === record.id || row.seq === record.seq)) {
      throw new Error("Duplicate offline queue identity");
    }
    this.persist([
      ...this.rows,
      Object.freeze({
        ...record,
        sealedPayload: Buffer.from(record.sealedPayload),
        state: "pending" as const,
      }),
    ]);
  }

  listOpen(): readonly StoredRow[] {
    return Object.freeze([...this.rows].sort((left, right) => left.seq - right.seq));
  }

  markInflight(id: string): void {
    const current = this.rows.find((row) => row.id === id);
    if (current === undefined) throw new Error("Unknown offline queue id");
    this.persist(
      this.rows.map((row) =>
        row.id === id ? Object.freeze({ ...row, state: "inflight" as const }) : row,
      ),
    );
  }

  ack(id: string): boolean {
    if (!this.rows.some((row) => row.id === id)) return false;
    this.persist(this.rows.filter((row) => row.id !== id));
    return true;
  }

  status(): Readonly<{ pendingCount: number; inflightCount: number }> {
    return Object.freeze({
      pendingCount: this.rows.filter((row) => row.state === "pending").length,
      inflightCount: this.rows.filter((row) => row.state === "inflight").length,
    });
  }

  clear(): void {
    this.rows = Object.freeze([]);
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}
