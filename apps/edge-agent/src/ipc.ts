import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";
import { isValidAppSender } from "./lib/sender.js";
import {
  createPairingSession,
  MemoryDeviceKeyStore,
  type PairingSession,
} from "./pairing/index.js";
import { createExecutionGate } from "./print/execution-gate.js";
import { DEFAULT_SAMPLE_TICKET, executeJob } from "./print/executor.js";
import { createMockSpool, enqueue, type MockSpool } from "./print/mock-spool.js";
import {
  createPrintJobStore,
  enqueuePrintJob,
  getPrintJob,
  listPrintJobStatus,
  type PrintJobKind,
  type PrintJobRecord,
  type PrintJobStatusView,
  type PrintJobStore,
} from "./print/print-jobs.js";
import { resolveUsbPrintPort } from "./print/usb-port.js";
import { MemoryEncryptedQueue, MemoryKekStore } from "./queue/index.js";
import { mockConnection } from "./shell/connection-mock.js";
import { checkShellHealth, type ShellHealth } from "./shell/health.js";
import { createInitialState, type UpgradeState } from "./upgrade/index.js";

const PRINT_KINDS: ReadonlySet<string> = new Set(["xp58", "dl206", "gp3120"]);
/** Process-wide FIFO for every mutating print IPC, including state selection and write-back. */
const printMutationGate = createExecutionGate();

export type IpcContext = {
  spaRoot: string;
  manifestPath: string;
  getUpgradeState: () => UpgradeState;
  getSpool: () => MockSpool;
  setSpool: (spool: MockSpool) => void;
  getPrintJobs: () => PrintJobStore;
  setPrintJobs: (store: PrintJobStore) => void;
  getPairing: () => PairingSession;
  getQueue: () => MemoryEncryptedQueue;
};

export type PrintProcessInput = Readonly<{
  jobId?: string;
  kind?: string;
  ticketNo?: string;
}>;

export type PrintEnqueueInput = string | Readonly<{ kind?: string; autoProcess?: boolean }>;

/** Status + receipt projection for process path — never raw payload bytes. */
export type PrintProcessResult = Readonly<{
  status: PrintJobStatusView;
  receipt: Readonly<{
    ticket_nonce: string;
    result: "succeeded" | "failed";
    seq: number;
    at: string;
  }>;
}>;

function assertAppSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url;
  if (!isValidAppSender(senderUrl)) {
    throw new Error("invalid sender");
  }
}

function parsePrintKind(kind: unknown): PrintJobKind {
  if (kind === undefined || kind === null || kind === "") {
    return "xp58";
  }
  if (typeof kind !== "string" || !PRINT_KINDS.has(kind)) {
    throw new Error("invalid print kind");
  }
  return kind as PrintJobKind;
}

function parseEnqueueArgs(raw: unknown): { kind: PrintJobKind; autoProcess: boolean } {
  if (raw === undefined || raw === null || typeof raw === "string") {
    const kind = parsePrintKind(raw);
    return { kind, autoProcess: kind === "xp58" };
  }
  if (typeof raw !== "object") {
    throw new Error("invalid print enqueue input");
  }
  const obj = raw as { kind?: unknown; autoProcess?: unknown };
  const kind = parsePrintKind(obj.kind);
  const autoProcess = typeof obj.autoProcess === "boolean" ? obj.autoProcess : kind === "xp58";
  return { kind, autoProcess };
}

function statusViewOf(job: PrintJobRecord): PrintJobStatusView {
  if (job.error !== undefined) {
    return Object.freeze({
      id: job.id,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error,
    });
  }
  return Object.freeze({
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}

function ticketForProcess(ticketNo: string | undefined) {
  if (ticketNo === undefined || ticketNo.length === 0) {
    return DEFAULT_SAMPLE_TICKET;
  }
  return Object.freeze({
    ...DEFAULT_SAMPLE_TICKET,
    ticketNo,
    barcode: ticketNo,
  });
}

/**
 * Browser IPC is a diagnostic/mock path only. Production device writes arrive
 * through the paired Edge transport and `SignedPrintExecutor`, never from a
 * renderer-originated IPC message with no server capability ticket.
 */
function assertUnsignedRendererPrintAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("renderer print execution is disabled in production; use signed Edge dispatch");
  }
}

function lastQueuedJob(store: PrintJobStore): PrintJobRecord | undefined {
  for (let i = store.jobs.length - 1; i >= 0; i -= 1) {
    const job = store.jobs[i];
    if (job?.status === "queued") return job;
  }
  return undefined;
}

async function runExecute(
  store: PrintJobStore,
  spool: MockSpool,
  jobId: string,
  mockJobId: string | undefined,
  ticketNo: string | undefined,
  now: number,
) {
  return executeJob(
    store,
    spool,
    jobId,
    ticketForProcess(ticketNo),
    { now, usbPort: resolveUsbPrintPort(process.env) },
    mockJobId,
  );
}

export function registerIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.ping, (event) => {
    assertAppSender(event);
    return {
      ok: true as const,
      data: {
        offlineCapable: true,
        mode: "edge-agent-d4",
        at: Date.now(),
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.health, (event): { ok: true; data: ShellHealth } => {
    assertAppSender(event);
    const data = checkShellHealth({
      spaRoot: ctx.spaRoot,
      manifestPath: ctx.manifestPath,
    });
    return { ok: true, data };
  });

  ipcMain.handle(IPC_CHANNELS.upgradeStatus, (event) => {
    assertAppSender(event);
    const state = ctx.getUpgradeState();
    return {
      ok: true as const,
      data: {
        mode: state.mode,
        activeSlot: state.activeSlot,
        primaryLeaseIssuanceBlocked: state.primaryLeaseIssuanceBlocked,
        contractPhaseDone: state.contractPhaseDone,
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.connection, (event) => {
    assertAppSender(event);
    return { ok: true as const, data: mockConnection() };
  });

  ipcMain.handle(IPC_CHANNELS.printEnqueue, (event, kindRaw: unknown = "xp58") => {
    assertAppSender(event);
    assertUnsignedRendererPrintAllowed();
    return printMutationGate(async () => {
      const { kind, autoProcess } = parseEnqueueArgs(kindRaw);
      const now = Date.now();
      const enq = enqueuePrintJob(ctx.getPrintJobs(), kind, now);
      const mock = enqueue(ctx.getSpool(), kind, now);
      if (autoProcess && kind === "xp58") {
        const result = await runExecute(
          enq.store,
          mock.spool,
          enq.job.id,
          mock.job.id,
          undefined,
          now,
        );
        ctx.setPrintJobs(result.store);
        ctx.setSpool(result.spool);
        const status = listPrintJobStatus(result.store).find((j) => j.id === enq.job.id);
        return { ok: true as const, data: status ?? null };
      }
      ctx.setPrintJobs(enq.store);
      ctx.setSpool(mock.spool);
      const status = listPrintJobStatus(enq.store).find((j) => j.id === enq.job.id);
      return { ok: true as const, data: status ?? null };
    });
  });

  ipcMain.handle(IPC_CHANNELS.printProcess, (event, raw: unknown = {}) => {
    assertAppSender(event);
    assertUnsignedRendererPrintAllowed();
    return printMutationGate(async () => {
      const input = (raw ?? {}) as PrintProcessInput;
      if (typeof input !== "object") {
        throw new Error("invalid print process input");
      }
      const now = Date.now();
      let store = ctx.getPrintJobs();
      let spool = ctx.getSpool();
      let jobId = typeof input.jobId === "string" ? input.jobId : undefined;
      let mockJobId: string | undefined;

      if (jobId) {
        const existing = getPrintJob(store, jobId);
        if (!existing) throw new Error(`print job not found: ${jobId}`);
      } else {
        const queued = lastQueuedJob(store);
        if (queued) {
          jobId = queued.id;
        } else {
          const kind = parsePrintKind(input.kind);
          const enq = enqueuePrintJob(store, kind, now);
          const mock = enqueue(spool, kind, now);
          store = enq.store;
          spool = mock.spool;
          jobId = enq.job.id;
          mockJobId = mock.job.id;
        }
      }

      const result = await runExecute(
        store,
        spool,
        jobId,
        mockJobId,
        typeof input.ticketNo === "string" ? input.ticketNo : undefined,
        now,
      );
      ctx.setPrintJobs(result.store);
      ctx.setSpool(result.spool);

      const data: PrintProcessResult = Object.freeze({
        status: statusViewOf(result.job),
        receipt: Object.freeze({
          ticket_nonce: result.receiptPayload.ticket_nonce,
          result: result.receiptPayload.result,
          seq: result.receiptPayload.seq,
          at: result.receiptPayload.at,
        }),
      });
      return { ok: true as const, data };
    });
  });

  ipcMain.handle(IPC_CHANNELS.printList, (event) => {
    assertAppSender(event);
    return { ok: true as const, data: listPrintJobStatus(ctx.getPrintJobs()) };
  });

  ipcMain.handle(IPC_CHANNELS.pairingCreateCode, (event) => {
    assertAppSender(event);
    const data = ctx.getPairing().createCode();
    return { ok: true as const, data };
  });

  ipcMain.handle(IPC_CHANNELS.pairingStatus, (event) => {
    assertAppSender(event);
    const data = ctx.getPairing().status();
    return { ok: true as const, data };
  });

  ipcMain.handle(IPC_CHANNELS.queueStatus, (event) => {
    assertAppSender(event);
    return { ok: true as const, data: ctx.getQueue().status() };
  });
}

export function createRuntimeState(): {
  upgrade: UpgradeState;
  spool: MockSpool;
  printJobs: PrintJobStore;
  pairing: PairingSession;
  queue: MemoryEncryptedQueue;
} {
  return {
    upgrade: createInitialState(),
    spool: createMockSpool(),
    printJobs: createPrintJobStore(),
    pairing: createPairingSession(new MemoryDeviceKeyStore()),
    queue: new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() }),
  };
}
