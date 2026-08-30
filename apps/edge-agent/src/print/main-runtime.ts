import type { KeyObject } from "node:crypto";
import { join } from "node:path";

import { PrinterQueueNameSchema } from "@laundry/contracts";

import type { EdgePrintHttpTransport } from "../desktop/print-http-transport.js";
import { ConfiguredPrinterRuntime, type PrinterPilot } from "./configured-runtime.js";
import { runMacPrinterPilot } from "./mac-printer-pilot.js";
import { PrinterConfigStore } from "./printer-config.js";
import { createPlatformRawPrintPort, type RawPrintPort } from "./raw-print-port.js";
import { createSignedPrintRuntime } from "./runtime.js";
import { runWindowsPrinterPilot } from "./windows-printer-pilot.js";

export function createMainPrinterPilot(
  platform: NodeJS.Platform,
  printPort: RawPrintPort,
): PrinterPilot {
  if (platform === "darwin") return runMacPrinterPilot;
  if (platform === "win32") {
    return (input) => runWindowsPrinterPilot(input, printPort);
  }
  throw new Error("PRINTER_PILOT_PLATFORM_UNSUPPORTED");
}

export async function configuredQueueForHealth(
  stateRoot: string,
  bootstrapQueue?: string,
): Promise<string | null> {
  const stored = await (await PrinterConfigStore.open(join(stateRoot, "printing"))).read();
  if (stored !== null) return stored.queue;
  const queue = bootstrapQueue?.trim() ?? "";
  return PrinterQueueNameSchema.safeParse(queue).success ? queue : null;
}

export async function discoverMainPrinterQueues(
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> {
  return await createPlatformRawPrintPort(platform).discoverQueues();
}

/** Compose the production OS spooler adapters around the testable configured runtime. */
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
    platform?: NodeJS.Platform;
  }>,
): Promise<ConfiguredPrinterRuntime> {
  const platform = options.platform ?? process.platform;
  const printPort = createPlatformRawPrintPort(platform);
  const printerPilot = createMainPrinterPilot(platform, printPort);
  const manager = new ConfiguredPrinterRuntime({
    store: await PrinterConfigStore.open(join(options.stateRoot, "printing")),
    pilot: printerPilot,
    runtimeEnabled: options.runtimeEnabled,
    createRuntime: (queue) =>
      createSignedPrintRuntime({
        stateRoot: join(options.stateRoot, "print-dispatch"),
        queue,
        deviceId: options.deviceId,
        devicePrivateKey: options.devicePrivateKey,
        serverPublicKey: options.serverPublicKey,
        ensureAuthority: options.ensureAuthority,
        queueReady: async () => (await printerPilot({ mode: "validate", queue })).ok,
        transport: options.transport,
        onStatus: (status) =>
          console.log("[edge-agent] signed print", status.state, status.message),
        onError: () => console.error("[edge-agent] signed print poll failed closed"),
        platform,
        printPort,
      }),
  });
  await manager.initialize(options.bootstrapQueue);
  return manager;
}
