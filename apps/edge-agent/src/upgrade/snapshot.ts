import { createHash } from "node:crypto";

/** Content-addressed snapshot id for upgrade-before DB copy (D5 skeleton). */
export function snapshotId(activeSlot: string, stamp: string): string {
  return `${stamp}-${activeSlot}.db.spike`;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Decide whether a restore may proceed: latest snapshot must exist and match hash.
 * Caller performs the actual file copy (Edge owns FS layout).
 */
export function canRestoreSnapshot(args: {
  snapshotExists: boolean;
  expectedHash?: string;
  actualHash?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!args.snapshotExists) {
    return { ok: false, error: "no_snapshot" };
  }
  if (args.expectedHash && args.actualHash && args.expectedHash !== args.actualHash) {
    return { ok: false, error: "snapshot_hash_mismatch" };
  }
  return { ok: true };
}
