/**
 * Print job executor (D4/M2) — render → ESC/POS → UsbPrintPort.write.
 * Never blocks forever; failures set error text and yield failed receipt.
 */
import type { ExecutionReceiptPayload } from "@laundry/contracts";

import { buildXp58EscPos } from "./escpos-xp58.js";
import { advanceJob, type MockPrintJob, type MockSpool } from "./mock-spool.js";
import {
  buildExecutionReceiptPayload,
  getPrintJob,
  transitionPrintJob,
  type PrintJobKind,
  type PrintJobRecord,
  type PrintJobStore,
} from "./print-jobs.js";
import {
  renderTicketTemplate,
  type RenderedTicket,
  type TicketTemplateInput,
} from "./template-render.js";
import { createMockUsbPort, type UsbPrintPort } from "./usb-port.js";

export type ExecuteJobResult = Readonly<{
  store: PrintJobStore;
  /** Parallel mock-spool mirror for existing half-step callers. */
  spool: MockSpool;
  job: PrintJobRecord;
  bytes: Uint8Array<ArrayBufferLike>;
  rendered: RenderedTicket | undefined;
  receiptPayload: ExecutionReceiptPayload;
}>;

export type ExecuteJobOptions = Readonly<{
  now?: number;
  /** Inject failure for tests / fault drills (never blocks). */
  forceError?: string;
  /**
   * Soft deadline for the write path. Exceeding it fails the job.
   * Default 5s — real USB adapters must honor the same bound.
   */
  timeoutMs?: number;
  at?: Date;
  /** USB/mock port; defaults to createMockUsbPort(). */
  usbPort?: UsbPrintPort;
}>;

/** Minimal default ticket for enqueue-only XP-58 smoke (no real PII). */
export const DEFAULT_SAMPLE_TICKET: TicketTemplateInput = Object.freeze({
  storeName: "宏发洗衣演示店",
  storePhone: "13800000001",
  ticketNo: "T202607210001",
  barcode: "HF202607210001",
  customerName: "演示顾客",
  receiveDate: "2026-07-21",
  pickupDate: "2026-07-23",
  lines: Object.freeze([Object.freeze({ name: "衬衫", qty: 2, unitPriceFen: 1500 })]),
  totalFen: 3000,
  paidFen: 3000,
  payMethod: "现金",
  noticeLines: Object.freeze(["请凭条码取衣"] as const),
  barcodeModuleWidth: 1,
});

function mirrorMockStatus(
  spool: MockSpool,
  mockId: string | undefined,
  status: MockPrintJob["status"],
  error: string | undefined,
  now: number,
): MockSpool {
  if (!mockId) return spool;
  return advanceJob(spool, mockId, status, error, now);
}

function kindSupported(kind: PrintJobKind): boolean {
  return kind === "xp58";
}

function finishOk(
  store: PrintJobStore,
  spool: MockSpool,
  jobId: string,
  mockJobId: string | undefined,
  payload: Uint8Array<ArrayBufferLike>,
  rendered: RenderedTicket | undefined,
  now: number,
  at: Date,
): ExecuteJobResult {
  const next = transitionPrintJob(store, jobId, "done", { now: now + 1 });
  const nextSpool = mirrorMockStatus(spool, mockJobId, "done", undefined, now + 1);
  const job = getPrintJob(next, jobId);
  if (!job) throw new Error("job missing after done transition");
  return Object.freeze({
    store: next,
    spool: nextSpool,
    job,
    bytes: payload,
    rendered,
    receiptPayload: buildExecutionReceiptPayload(job, at),
  });
}

function finishFailed(
  store: PrintJobStore,
  spool: MockSpool,
  jobId: string,
  mockJobId: string | undefined,
  payload: Uint8Array<ArrayBufferLike>,
  rendered: RenderedTicket | undefined,
  message: string,
  now: number,
  at: Date,
): ExecuteJobResult {
  const next = transitionPrintJob(store, jobId, "failed", {
    error: message,
    now: now + 1,
  });
  const nextSpool = mirrorMockStatus(spool, mockJobId, "failed", message, now + 1);
  const job = getPrintJob(next, jobId);
  if (!job) throw new Error("job missing after failed transition");
  return Object.freeze({
    store: next,
    spool: nextSpool,
    job,
    bytes: payload,
    rendered,
    receiptPayload: buildExecutionReceiptPayload(job, at),
  });
}

/**
 * Execute one queued print job: render → ESC/POS → usbPort.write.
 * State: queued → printing → done | failed. Always settles (never hangs).
 */
export async function executeJob(
  store: PrintJobStore,
  spool: MockSpool,
  jobId: string,
  ticket: TicketTemplateInput = DEFAULT_SAMPLE_TICKET,
  options: ExecuteJobOptions = {},
  mockJobId?: string,
): Promise<ExecuteJobResult> {
  const now = options.now ?? Date.now();
  const at = options.at ?? new Date(now);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const usbPort = options.usbPort ?? createMockUsbPort();

  const queued = getPrintJob(store, jobId);
  if (!queued) {
    throw new Error(`print job not found: ${jobId}`);
  }
  if (queued.status !== "queued") {
    throw new Error(`executeJob requires queued status, got ${queued.status}`);
  }

  const next = transitionPrintJob(store, jobId, "printing", { now });
  const nextSpool = mirrorMockStatus(spool, mockJobId, "printing", undefined, now);

  let rendered: RenderedTicket | undefined;
  let payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  try {
    if (options.forceError) {
      throw new Error(options.forceError);
    }
    if (!kindSupported(queued.kind)) {
      throw new Error(`unsupported print kind for D4 skeleton: ${queued.kind}`);
    }

    rendered = renderTicketTemplate(ticket);
    payload = buildXp58EscPos(rendered);
    if (payload.byteLength === 0) {
      throw new Error("empty ESC/POS payload");
    }

    await usbPort.write(payload, { timeoutMs });

    return finishOk(next, nextSpool, jobId, mockJobId, payload, rendered, now, at);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return finishFailed(next, nextSpool, jobId, mockJobId, payload, rendered, message, now, at);
  }
}
