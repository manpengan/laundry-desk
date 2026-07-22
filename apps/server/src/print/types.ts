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

export type TransitionPrintJobOptions = Readonly<{
  error?: string;
  now?: number;
  /** Set when status becomes done after ESC/POS build. */
  payload_bytes?: number;
}>;

export type PrintJobStore = Readonly<{
  enqueue: (input: EnqueuePrintJobInput) => Promise<PrintJobRecord>;
  list: (limit: number) => Promise<readonly PrintJobStatusView[]>;
  get: (jobId: string) => Promise<PrintJobRecord | null>;
  transition: (
    jobId: string,
    status: PrintJobStatus,
    options?: TransitionPrintJobOptions,
  ) => Promise<PrintJobRecord>;
}>;
