/**
 * Server-side print job queue types (M2).
 * Status flow: queued → printing → done | failed.
 * payload_bytes is ESC/POS length after successful process (no device paths stored).
 */

export type PrintJobStatus = "queued" | "printing" | "done" | "failed";
export type PrintJobKind = "xp58" | "dl206" | "gp3120";

export type PrintJobRecord = Readonly<{
  job_id: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  order_id: string;
  ticket_no: string;
  /** Epoch seconds. */
  created_at: number;
  /** Epoch seconds. */
  updated_at: number;
  error?: string;
  /** ESC/POS byte length after process (done jobs). */
  payload_bytes?: number;
}>;

/** Status projection for API responses (no device paths). */
export type PrintJobStatusView = Readonly<{
  job_id: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  order_id: string;
  ticket_no: string;
  created_at: number;
  updated_at: number;
  error?: string;
  payload_bytes?: number;
}>;

export type EnqueuePrintJobInput = Readonly<{
  order_id: string;
  ticket_no: string;
  kind: PrintJobKind;
  job_id?: string;
  now?: number;
}>;

/** What the spool actually wrote; recorded as one unit on a successful print. */
export type PrintArtifactRef = Readonly<{
  /** Spool-relative artifact name. Never absolute, never traversing. */
  path: string;
  sha256: string;
  bytes: number;
}>;

export type TransitionPrintJobOptions = Readonly<{
  error?: string;
  now?: number;
  /** Set when status becomes done after ESC/POS build. */
  payload_bytes?: number;
  /** Set when status becomes done after the spool installed the artifact. */
  artifact?: PrintArtifactRef;
}>;

/** Default lease window; a worker must finish or renew before it expires. */
export const DEFAULT_LEASE_SECONDS = 30;

/**
 * Give up after this many claims of the same job. Guards a poison payload that
 * kills its worker every time, which would otherwise be re-claimed forever.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

export type ClaimPrintJobInput = Readonly<{
  /** Identifies the claiming worker; stored so a stuck lease is attributable. */
  worker_id: string;
  lease_seconds?: number;
  max_attempts?: number;
  now?: number;
}>;

/** A held lease. `attempt_count` includes the claim that produced this record. */
export type PrintJobClaim = Readonly<{
  job_id: string;
  kind: PrintJobKind;
  order_id: string;
  ticket_no: string;
  attempt_count: number;
  /** Epoch seconds; the claim is void once passed. */
  lease_until: number;
  worker_id: string;
}>;

export type PrintJobStore = Readonly<{
  enqueue: (input: EnqueuePrintJobInput) => Promise<PrintJobRecord>;
  list: (limit: number) => Promise<readonly PrintJobStatusView[]>;
  get: (jobId: string) => Promise<PrintJobRecord | null>;
  /**
   * Atomically take the oldest claimable job, or null when there is none.
   *
   * Claimable means queued, or printing with an expired lease — a worker that
   * died mid-print leaves the row in `printing`, and the status machine forbids
   * moving back to `queued`, so recovery re-claims in place. A job that has
   * already been attempted `max_attempts` times is failed instead of returned.
   */
  claimNext?: (input: ClaimPrintJobInput) => Promise<PrintJobClaim | null>;
  /**
   * Claim one specific job. `print.ticket.process` names the job it wants, so
   * the queue-order claim above cannot serve it. Returns null when that job is
   * not claimable — already terminal, out of attempts, or leased by someone
   * else whose lease has not expired.
   */
  claimJob?: (jobId: string, input: ClaimPrintJobInput) => Promise<PrintJobClaim | null>;
  /** Recorded artifact for a finished job, or null when it has none. */
  findArtifact?: (jobId: string) => Promise<PrintArtifactRef | null>;
  transition: (
    jobId: string,
    status: PrintJobStatus,
    options?: TransitionPrintJobOptions,
  ) => Promise<PrintJobRecord>;
}>;
