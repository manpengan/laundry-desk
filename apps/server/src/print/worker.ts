/**
 * Mock print worker (product design §7).
 *
 * One step is: claim a job under lease → render a UTF-8 text artifact → install
 * it in the spool → move the job to done recording the artifact, or to failed
 * recording a safe error code.
 *
 * The render is a fixed template over already-validated job fields. Nothing
 * from the caller is interpreted, no shell is spawned, and the worker never
 * chooses a path — the spool derives the filename from the job id.
 */

import { SpoolError, type FileSpool } from "./file-spool.js";
import type { ClaimPrintJobInput, PrintJobClaim, PrintJobKind, PrintJobStore } from "./types.js";

export type PrintWorkerDeps = Readonly<{
  store: PrintJobStore;
  spool: FileSpool;
  workerId: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  now?: () => number;
}>;

export type PrintWorkerOutcome =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "printed"; job_id: string; artifact_path: string; reused: boolean }>
  | Readonly<{ kind: "failed"; job_id: string; error_code: string }>;

/** Fixed-width mock receipt. Deliberately boring: it is not a template engine. */
export function renderArtifact(claim: PrintJobClaim, printedAt: number): string {
  const lines = [
    "=== LAUNDRY DESK MOCK PRINT ===",
    `printer   : ${claim.kind}`,
    `ticket    : ${claim.ticket_no}`,
    `order     : ${claim.order_id}`,
    `job       : ${claim.job_id}`,
    `attempt   : ${claim.attempt_count}`,
    `printed_at: ${new Date(printedAt * 1000).toISOString()}`,
    "=== END ===",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Failures are recorded as a stable code, never a raw message — an error text
 * could otherwise carry a filesystem path into the job record and out to the UI.
 */
function safeErrorCode(error: unknown): string {
  if (error instanceof SpoolError) return error.code;
  return "PRINT_WORKER_FAILED";
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<PrintJobKind>(["xp58", "dl206", "gp3120"]);

/**
 * Take at most one job and drive it to a terminal state.
 * Returns `idle` when the queue has nothing claimable.
 */
export async function runPrintWorkerOnce(deps: PrintWorkerDeps): Promise<PrintWorkerOutcome> {
  const claimNext = deps.store.claimNext;
  if (claimNext === undefined) {
    throw new Error("print worker requires a store that supports claiming");
  }
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const claimInput: ClaimPrintJobInput = Object.freeze({
    worker_id: deps.workerId,
    now: now(),
    ...(deps.leaseSeconds === undefined ? {} : { lease_seconds: deps.leaseSeconds }),
    ...(deps.maxAttempts === undefined ? {} : { max_attempts: deps.maxAttempts }),
  });

  const claim = await claimNext(claimInput);
  if (claim === null) return Object.freeze({ kind: "idle" as const });

  try {
    if (!KNOWN_KINDS.has(claim.kind)) {
      throw new SpoolError("PRINT_UNKNOWN_KIND", "unsupported printer kind");
    }
    const printedAt = now();
    const artifact = await deps.spool.write({
      job_id: claim.job_id,
      kind: claim.kind,
      seq: claim.attempt_count,
      content: renderArtifact(claim, printedAt),
    });
    await deps.store.transition(claim.job_id, "done", {
      now: printedAt,
      payload_bytes: artifact.bytes,
      artifact: Object.freeze({
        path: artifact.relative_path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      }),
    });
    return Object.freeze({
      kind: "printed" as const,
      job_id: claim.job_id,
      artifact_path: artifact.relative_path,
      reused: artifact.reused,
    });
  } catch (error) {
    const code = safeErrorCode(error);
    // Leaving the job in `printing` would let the lease expire and retry a
    // payload we already know is bad, so record the terminal failure now.
    await deps.store.transition(claim.job_id, "failed", { now: now(), error: code });
    return Object.freeze({ kind: "failed" as const, job_id: claim.job_id, error_code: code });
  }
}

/**
 * Drain the queue up to `limit` jobs. Bounded on purpose: an unbounded loop in
 * a request path or a test could spin on a queue that keeps refilling.
 */
export async function drainPrintQueue(
  deps: PrintWorkerDeps,
  limit = 50,
): Promise<readonly PrintWorkerOutcome[]> {
  const outcomes: PrintWorkerOutcome[] = [];
  for (let index = 0; index < limit; index += 1) {
    const outcome = await runPrintWorkerOnce(deps);
    if (outcome.kind === "idle") break;
    outcomes.push(outcome);
  }
  return Object.freeze(outcomes);
}
