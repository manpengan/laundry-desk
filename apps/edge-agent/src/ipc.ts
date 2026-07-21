import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "./lib/security-prefs.js";
import { isValidAppSender } from "./lib/sender.js";
import {
  createPairingSession,
  MemoryDeviceKeyStore,
  type PairingSession,
} from "./pairing/index.js";
import {
  createMockSpool,
  enqueue,
  listJobs,
  type MockPrintJob,
  type MockSpool,
} from "./print/mock-spool.js";
import { mockConnection } from "./shell/connection-mock.js";
import { checkShellHealth, type ShellHealth } from "./shell/health.js";
import { createInitialState, type UpgradeState } from "./upgrade/index.js";

export type IpcContext = {
  spaRoot: string;
  manifestPath: string;
  getUpgradeState: () => UpgradeState;
  getSpool: () => MockSpool;
  setSpool: (spool: MockSpool) => void;
  getPairing: () => PairingSession;
};

function assertAppSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url;
  if (!isValidAppSender(senderUrl)) {
    throw new Error("invalid sender");
  }
}

export function registerIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.ping, (event) => {
    assertAppSender(event);
    return {
      ok: true as const,
      data: {
        offlineCapable: true,
        mode: "edge-agent-d2",
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

  ipcMain.handle(IPC_CHANNELS.printEnqueue, (event, kind: MockPrintJob["kind"] = "xp58") => {
    assertAppSender(event);
    const { spool, job } = enqueue(ctx.getSpool(), kind);
    ctx.setSpool(spool);
    return { ok: true as const, data: job };
  });

  ipcMain.handle(IPC_CHANNELS.printList, (event) => {
    assertAppSender(event);
    return { ok: true as const, data: listJobs(ctx.getSpool()) };
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
}

/** Default runtime state bag for main process. */
export function createRuntimeState(): {
  upgrade: UpgradeState;
  spool: MockSpool;
  pairing: PairingSession;
} {
  return {
    upgrade: createInitialState(),
    spool: createMockSpool(),
    // Production must swap MemoryDeviceKeyStore for OS credential-store adapter.
    pairing: createPairingSession(new MemoryDeviceKeyStore()),
  };
}
