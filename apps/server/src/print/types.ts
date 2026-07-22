/**
 * Server-side print job queue types (M2 memory skeleton).
 * Status flow: queued → printing → done | failed.
 * Status views never expose device paths or payload bytes.
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
}>;

/** Status-only projection safe for API responses (no device paths / bytes). */
export type PrintJobStatusView = Readonly<{
  job_id: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  order_id: string;
  ticket_no: string;
  created_at: number;
  updated_at: number;
  error?: string;
}>;

export type EnqueuePrintJobInput = Readonly<{
  order_id: string;
  ticket_no: string;
  kind: PrintJobKind;
  job_id?: string;
  now?: number;
}>;

export type PrintJobStore = Readonly<{
  enqueue: (input: EnqueuePrintJobInput) => Promise<PrintJobRecord>;
  list: (limit: number) => Promise<readonly PrintJobStatusView[]>;
  get: (jobId: string) => Promise<PrintJobRecord | null>;
  transition: (
    jobId: string,
    status: PrintJobStatus,
    options?: Readonly<{ error?: string; now?: number }>,
  ) => Promise<PrintJobRecord>;
}>;
