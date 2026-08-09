import type { KeyObject } from "node:crypto";
import { join } from "node:path";

import type { EdgePrintHttpTransport } from "../desktop/print-http-transport.js";
import { ConfiguredPrinterRuntime } from "./configured-runtime.js";
import { isCupsQueueName } from "./cups-queue.js";
import { runMacPrinterPilot } from "./mac-printer-pilot.js";
import { PrinterConfigStore } from "./printer-config.js";
import { createSignedPrintRuntime } from "./runtime.js";

export async function configuredQueueForHealth(
  stateRoot: string,
  bootstrapQueue?: string,
): Promise<string | null> {
  const stored = await (await PrinterConfigStore.open(join(stateRoot, "printing"))).read();
  if (stored !== null) return stored.queue;
  const queue = bootstrapQueue?.trim() ?? "";
  return isCupsQueueName(queue) ? queue : null;
}

/** Compose the production-only CUPS adapters around the testable configured runtime. */
export async function createMainPrinterRuntime(
  options: Readonly<{
    stateRoot: string;
    bootstrapQueue?: string;
    runtimeEnabled: boolean;
    deviceId: string;
    devicePrivateKey: KeyObject;
    serverPublicKey: () => KeyObject | null;
    ensureAuthority: () => Promise<boolean>;
    transport: EdgePrintHttpTransport;
  }>,
): Promise<ConfiguredPrinterRuntime> {
  const manager = new ConfiguredPrinterRuntime({
    store: await PrinterConfigStore.open(join(options.stateRoot, "printing")),
    pilot: runMacPrinterPilot,
    runtimeEnabled: options.runtimeEnabled,
    createRuntime: (queue) =>
      createSignedPrintRuntime({
        stateRoot: join(options.stateRoot, "print-dispatch"),
        queue,
        deviceId: options.deviceId,
        devicePrivateKey: options.devicePrivateKey,
        serverPublicKey: options.serverPublicKey,
        ensureAuthority: options.ensureAuthority,
        queueReady: async () => (await runMacPrinterPilot({ mode: "validate", queue })).ok,
        transport: options.transport,
        onStatus: (status) =>
          console.log("[edge-agent] signed print", status.state, status.message),
        onError: () => console.error("[edge-agent] signed print poll failed closed"),
      }),
  });
  await manager.initialize(options.bootstrapQueue);
  return manager;
}
