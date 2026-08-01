import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";
import { isValidAppSender } from "./lib/sender.js";
import {
  createPairingSession,
  MemoryDeviceKeyStore,
  type PairingSession,
} from "./pairing/index.js";
import { createExecutionGate } from "./print/execution-gate.js";
import { createMockSpool, enqueue, type MockSpool } from "./print/mock-spool.js";
import {
  createPrintJobStore,
  enqueuePrintJob,
  listPrintJobStatus,
  type PrintJobKind,
  type PrintJobStore,
} from "./print/print-jobs.js";
import { MemoryEncryptedQueue, MemoryKekStore } from "./queue/index.js";
import { mockConnection } from "./shell/connection-mock.js";
import { checkShellHealth, type ShellHealth } from "./shell/health.js";
import { createInitialState, type UpgradeState } from "./upgrade/index.js";

const PRINT_KINDS: ReadonlySet<string> = new Set(["xp58", "dl206", "gp3120"]);
/** Process-wide FIFO for every mutating print IPC, including state selection and write-back. */
const printMutationGate = createExecutionGate();

export type IpcContext = {
  /** Test-only legacy mock path. Product main never registers these handlers. */
  allowUnsignedRendererPrint: boolean;
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
}>;

export type PrintEnqueueInput = string | Readonly<{ kind?: string }>;

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

function parseEnqueueArgs(raw: unknown): { kind: PrintJobKind } {
  if (raw === undefined || raw === null || typeof raw === "string") {
    return { kind: parsePrintKind(raw) };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid print enqueue input");
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => key !== "kind")) {
    throw new Error("invalid print enqueue input");
  }
  return { kind: parsePrintKind(Reflect.get(raw, "kind")) };
}

/**
 * Browser IPC is a diagnostic/mock path only. Production device writes arrive
 * through the paired Edge transport and `SignedPrintExecutor`, never from a
 * renderer-originated IPC message with no server capability ticket.
 */
function assertUnsignedRendererPrintAllowed(allowed: boolean): void {
  if (!allowed) {
    throw new Error("renderer print execution is disabled; use signed Edge dispatch");
  }
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
    assertUnsignedRendererPrintAllowed(ctx.allowUnsignedRendererPrint);
    return printMutationGate(async () => {
      const { kind } = parseEnqueueArgs(kindRaw);
      const now = Date.now();
      const enq = enqueuePrintJob(ctx.getPrintJobs(), kind, now);
      const mock = enqueue(ctx.getSpool(), kind, now);
      ctx.setPrintJobs(enq.store);
      ctx.setSpool(mock.spool);
      const status = listPrintJobStatus(enq.store).find((j) => j.id === enq.job.id);
      return { ok: true as const, data: status ?? null };
    });
  });

  ipcMain.handle(IPC_CHANNELS.printProcess, (event, raw: unknown = {}) => {
    assertAppSender(event);
    assertUnsignedRendererPrintAllowed(ctx.allowUnsignedRendererPrint);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid print process input");
    }
    throw new Error("renderer print execution is disabled; use signed Edge dispatch");
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
