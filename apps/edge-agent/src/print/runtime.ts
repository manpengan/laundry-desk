import { performance } from "node:perf_hooks";

import type { KeyObject } from "node:crypto";

import type { EdgePrintHttpTransport } from "../desktop/print-http-transport.js";
import { createPrintContinuity, type PrintContinuity } from "./continuity.js";
import { discoverCupsQueues, submitCupsBytes } from "./cups-process.js";
import {
  createPrintDispatchController,
  type PrintDispatchController,
  type PrintDispatchControllerStatus,
} from "./dispatch-controller.js";
import { PrintDispatchLedger } from "./dispatch-ledger.js";
import { createSignedPrintExecutor } from "./signed-executor.js";

export type SignedPrintRuntime = Readonly<{
  controller: PrintDispatchController;
  continuity: PrintContinuity;
}>;

export async function createSignedPrintRuntime(
  options: Readonly<{
    stateRoot: string;
    queue: string;
    deviceId: string;
    devicePrivateKey: KeyObject;
    serverPublicKey: () => KeyObject | null;
    ensureAuthority: () => Promise<boolean>;
    queueReady?: () => Promise<boolean>;
    transport: EdgePrintHttpTransport;
    onStatus?: (status: PrintDispatchControllerStatus) => void;
    onError: (error: unknown) => void;
    platform?: NodeJS.Platform;
  }>,
): Promise<SignedPrintRuntime> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Signed CUPS print runtime requires macOS");
  }
  const continuity = createPrintContinuity();
  const ledger = await PrintDispatchLedger.open(options.stateRoot);
  const executor = createSignedPrintExecutor({
    ledger,
    deviceId: options.deviceId,
    queue: options.queue,
    devicePrivateKey: options.devicePrivateKey,
    serverPublicKey: options.serverPublicKey,
    discoverQueues: discoverCupsQueues,
    submitCups: submitCupsBytes,
    monotonicNowMs: () => performance.now(),
  });
  const controller = createPrintDispatchController({
    transport: options.transport,
    executor,
    ledger,
    continuity,
    readyToClaim: async () => {
      if (options.queueReady !== undefined && !(await options.queueReady())) return false;
      return options.serverPublicKey() !== null || (await options.ensureAuthority());
    },
    onError: options.onError,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  });
  return Object.freeze({ controller, continuity });
}
