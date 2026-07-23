/**
 * Operator printer-path smoke (M2 Edge).
 * Verifies LAUNDRY_PRINTER_PATH without full app UI.
 * Product configuration accepts POSIX character devices and Windows COM/LPT/USB endpoints.
 * Never hangs — write path always races a timeout.
 */

import { escCut, escFeed, escInit, escLine } from "./escpos-xp58.js";
import {
  normalizePrinterPath,
  PRINTER_PATH_ENV,
  resolveUsbPrintPort,
  validatePrinterDevicePath,
  type PrinterDeviceDependencies,
  type UsbPrintPort,
} from "./usb-port.js";

export type PrinterSmokeResult = Readonly<{
  ok: boolean;
  /** Normalized path used for the probe; null when mock. */
  path: string | null;
  kind: "mock" | "usb" | "missing";
  message: string;
  bytes_written?: number;
}>;

export type PrinterSmokeOptions = Readonly<{
  payload?: Uint8Array;
  timeoutMs?: number;
  /** Validate product configuration without opening or writing the device. */
  validateOnly?: boolean;
  /** Explicit test/diagnostic injection; bypasses product env path resolution. */
  usbPort?: UsbPrintPort;
  /** Platform/stat injection for deterministic validation tests. */
  deviceDependencies?: PrinterDeviceDependencies;
}>;

export { PRINTER_PATH_ENV, normalizePrinterPath };

const DEFAULT_TIMEOUT_MS = 5_000;
const SMOKE_LINE = "LAUNDRY printer smoke OK";

function resolveConfiguredPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env[PRINTER_PATH_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const normalized = normalizePrinterPath(raw);
    return normalized.length > 0 ? normalized : null;
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

/** Path / device does not exist (ENOENT or Windows equivalent). */
export function isMissingDeviceError(message: string): boolean {
  return (
    /ENOENT|no such file|not found|cannot find|the system cannot find/i.test(message) ||
    /unknown device|invalid name/i.test(message)
  );
}

/** Permission / sharing failure (EACCES, EPERM, Windows access denied). */
export function isAccessDeniedError(message: string): boolean {
  return /EACCES|EPERM|access is denied|access denied|permission denied|EBUSY|resource busy|sharing violation/i.test(
    message,
  );
}

function annotateError(path: string, message: string): string {
  if (isAccessDeniedError(message)) {
    return (
      `Access denied writing ${path}: ${message}. ` +
      "Close other apps using the port, run elevated if needed, " +
      "or pick another COM/USB share (Device Manager → Ports)."
    );
  }
  if (isMissingDeviceError(message)) {
    return (
      `Path missing: ${path} (${message}). ` +
      "Check Device Manager for COM/USB###, or use a file redirect path first."
    );
  }
  return message;
}

function mockResult(): PrinterSmokeResult {
  return Object.freeze({
    ok: true,
    path: null,
    kind: "mock" as const,
    message:
      "Mock print port active (no hardware write). " +
      `Set ${PRINTER_PATH_ENV} to a printer device to probe output — ` +
      "e.g. /dev/usb/lp0, \\\\.\\COM3, \\\\.\\LPT1, \\\\.\\USB001, or COM3.",
  });
}

function validatedResult(path: string): PrinterSmokeResult {
  return Object.freeze({
    ok: true,
    path,
    kind: "usb" as const,
    message: `Validated printer device path ${path} (no bytes written)`,
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
 * Windows operators may set COM3 / \\.\COM3 / \\.\LPT1 / \\.\USB001.
 * Tests that need spool files must inject options.usbPort explicitly.
 */
export async function runPrinterSmoke(
  env: NodeJS.ProcessEnv,
  options: PrinterSmokeOptions = {},
): Promise<PrinterSmokeResult> {
  const path = resolveConfiguredPath(env);
  if (path === null) {
    return mockResult();
  }

  let port: UsbPrintPort;
  try {
    if (options.validateOnly === true) {
      return validatedResult(validatePrinterDevicePath(path, options.deviceDependencies));
    }
    port = options.usbPort ?? resolveUsbPrintPort(env, options.deviceDependencies);
  } catch (err) {
    const raw = errorMessage(err);
    const message = annotateError(path, raw);
    return failResult(path, isMissingDeviceError(raw) ? "missing" : "usb", message);
  }

  if (port.kind === "mock") {
    return mockResult();
  }

  const payload = options.payload ?? buildPrinterSmokePayload();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    await port.write(payload, { timeoutMs });
    return okUsbResult(path, payload.byteLength);
  } catch (err) {
    const raw = errorMessage(err);
    const message = annotateError(path, raw);
    if (isMissingDeviceError(raw)) {
      return failResult(path, "missing", message);
    }
    return failResult(path, "usb", message);
  }
}
