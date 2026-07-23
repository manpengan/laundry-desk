/**
 * Operator printer-path smoke (M2 Edge).
 * Verifies LAUNDRY_PRINTER_PATH without full app UI.
 * Never hangs — write path always races a timeout.
 */

import { escCut, escFeed, escInit, escLine } from "./escpos-xp58.js";
import { resolveUsbPrintPort } from "./usb-port.js";

export type PrinterSmokeResult = Readonly<{
  ok: boolean;
  path: string | null;
  kind: "mock" | "usb" | "missing";
  message: string;
  bytes_written?: number;
}>;

export type PrinterSmokeOptions = Readonly<{
  payload?: Uint8Array;
  timeoutMs?: number;
}>;

const PRINTER_PATH_ENV = "LAUNDRY_PRINTER_PATH";
const DEFAULT_TIMEOUT_MS = 5_000;
const SMOKE_LINE = "LAUNDRY printer smoke OK";

function resolveConfiguredPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env[PRINTER_PATH_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

/** Tiny ESC/POS self-test: init + text line + feed + partial cut. */
export function buildPrinterSmokePayload(line: string = SMOKE_LINE): Uint8Array {
  const parts = [escInit(), escLine(line), escFeed(2), escCut(1)];
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) {
    return err.message;
  }
  return String(err);
}

function isMissingDeviceError(message: string): boolean {
  return /ENOENT|no such file|not found|cannot find/i.test(message);
}

function mockResult(): PrinterSmokeResult {
  return Object.freeze({
    ok: true,
    path: null,
    kind: "mock" as const,
    message:
      "Mock print port active (no hardware write). " +
      `Set ${PRINTER_PATH_ENV} to a device node or spool file ` +
      "(e.g. /dev/usb/lp0 or a temp file) to probe USB.",
  });
}

function okUsbResult(path: string, bytesWritten: number): PrinterSmokeResult {
  return Object.freeze({
    ok: true,
    path,
    kind: "usb" as const,
    message: `Wrote ${bytesWritten} bytes to ${path}`,
    bytes_written: bytesWritten,
  });
}

function failResult(path: string, kind: "usb" | "missing", message: string): PrinterSmokeResult {
  return Object.freeze({
    ok: false,
    path,
    kind,
    message,
  });
}

/**
 * Probe the resolved USB print port with a tiny ESC/POS self-test payload.
 * Mock → ok without writing. USB → write with timeout; never hangs.
 */
export async function runPrinterSmoke(
  env: NodeJS.ProcessEnv,
  options: PrinterSmokeOptions = {},
): Promise<PrinterSmokeResult> {
  const path = resolveConfiguredPath(env);
  const port = resolveUsbPrintPort(env);

  if (port.kind === "mock" || path === null) {
    return mockResult();
  }

  const payload = options.payload ?? buildPrinterSmokePayload();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    await port.write(payload, { timeoutMs });
    return okUsbResult(path, payload.byteLength);
  } catch (err) {
    const message = errorMessage(err);
    if (isMissingDeviceError(message)) {
      return failResult(path, "missing", message);
    }
    return failResult(path, "usb", message);
  }
}
