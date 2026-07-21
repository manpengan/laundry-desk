import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";
import { isValidAppSender } from "./lib/sender.js";
import {
  createPairingSession,
  MemoryDeviceKeyStore,
  type PairingSession,
} from "./pairing/index.js";
import { DEFAULT_SAMPLE_TICKET, executeJob } from "./print/executor.js";
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

  // D4: print:enqueue — status view only; no device paths / raw bytes / ticket nonce.
  ipcMain.handle(IPC_CHANNELS.printEnqueue, (event, kindRaw: unknown = "xp58") => {
    assertAppSender(event);
    const kind = parsePrintKind(kindRaw);
    const now = Date.now();

    const enq = enqueuePrintJob(ctx.getPrintJobs(), kind, now);
    const mock = enqueue(ctx.getSpool(), kind, now);

    // Auto-execute XP-58 via mock spool (sync, never blocks forever).
    if (kind === "xp58") {
      const result = executeJob(
        enq.store,
        mock.spool,
        enq.job.id,
        DEFAULT_SAMPLE_TICKET,
        { now },
        mock.job.id,
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

  // D4: print:list — status only.
  ipcMain.handle(IPC_CHANNELS.printList, (event) => {
    assertAppSender(event);
    return { ok: true as const, data: listPrintJobStatus(ctx.getPrintJobs()) };
  });

  // D2 pairing — public surface only; private keys never cross IPC.
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

  // D3 queue — status only; DEK/KEK/envelopes never cross IPC.
  ipcMain.handle(IPC_CHANNELS.queueStatus, (event) => {
    assertAppSender(event);
    return { ok: true as const, data: ctx.getQueue().status() };
  });
}

/** Default runtime state bag for main process. */
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
    // Production must swap MemoryDeviceKeyStore for OS credential-store adapter.
    pairing: createPairingSession(new MemoryDeviceKeyStore()),
    queue: new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() }),
  };
}
