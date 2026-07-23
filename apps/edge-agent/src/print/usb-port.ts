/**
 * USB print port adapter (M2 Edge).
 * Mock by default; optional file/device path via LAUNDRY_PRINTER_PATH (no node-usb).
 * Accepts POSIX nodes, spool files, and Windows COM/USB device paths.
 * Writes never hang forever — timeoutMs is honored via race.
 */

import { open } from "node:fs/promises";

export type UsbPrintPort = Readonly<{
  /** Write ESC/POS bytes to device (or mock). Never hang forever. */
  write(bytes: Uint8Array, options?: { timeoutMs?: number }): Promise<void>;
  readonly kind: "mock" | "usb";
}>;

export type MockUsbPortOptions = Readonly<{
  /** When set, write rejects with this message after optional delay. */
  failWith?: string;
  /** Artificial delay for timeout tests (ms). */
  delayMs?: number;
}>;

const DEFAULT_WRITE_TIMEOUT_MS = 5_000;

/** Env key used by resolveUsbPrintPort / runPrinterSmoke. */
export const PRINTER_PATH_ENV = "LAUNDRY_PRINTER_PATH";

/** `\\.\COM3`, `\\.\USB001` (Windows device namespace). */
const WIN_DEVICE_NS = /^\\\\\.\\/i;
/** Bare `COM3` / `com12` (Windows serial). */
const BARE_COM = /^com(\d+)$/i;
/** Bare `USB001` (Windows USB printing support virtual port). */
const BARE_USB = /^usb(\d+)$/i;
/** POSIX character device under /dev (lp / usb / tty). */
const POSIX_DEV = /^\/dev\//i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`USB write timed out after ${timeoutMs}ms`);
}

/**
 * Race `work` against a wall-clock timeout. Clears the timer on settle.
 */
async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/**
 * True when path is a Windows device namespace path (`\\.\…`).
 */
export function isWindowsDevicePath(devicePath: string): boolean {
  return WIN_DEVICE_NS.test(devicePath.trim());
}

/**
 * True when path is a POSIX device node under `/dev/`.
 */
export function isPosixDevicePath(devicePath: string): boolean {
  return POSIX_DEV.test(devicePath.trim());
}

/**
 * Normalize operator-friendly printer paths for open/write.
 *
 * - `COM3` / `com3` → `\\.\COM3`
 * - `USB001` → `\\.\USB001`
 * - `\\.\COM3` kept (COM/USB id uppercased)
 * - File paths and `/dev/…` nodes unchanged (quotes stripped, trim only)
 *
 * Does not invent a path when empty.
 */
export function normalizePrinterPath(raw: string): string {
  const trimmed = stripSurroundingQuotes(raw.trim());
  if (trimmed.length === 0) {
    return trimmed;
  }

  // Accept forward-slash device form sometimes pasted from docs: //./COM3
  const unified = trimmed.replace(/^\/\/\.\//, "\\\\.\\");

  if (WIN_DEVICE_NS.test(unified)) {
    const rest = unified.slice(4);
    const com = rest.match(BARE_COM);
    if (com) {
      return `\\\\.\\COM${com[1]}`;
    }
    const usb = rest.match(BARE_USB);
    if (usb) {
      return `\\\\.\\USB${usb[1]}`;
    }
    return unified;
  }

  const bareCom = unified.match(BARE_COM);
  if (bareCom) {
    return `\\\\.\\COM${bareCom[1]}`;
  }
  const bareUsb = unified.match(BARE_USB);
  if (bareUsb) {
    return `\\\\.\\USB${bareUsb[1]}`;
  }

  return unified;
}

/**
 * In-process mock USB port — no hardware, no node-usb.
 * If delayMs exceeds timeoutMs, fails with a timeout error (never hangs).
 */
export function createMockUsbPort(options: MockUsbPortOptions = {}): UsbPrintPort {
  const delayMs = options.delayMs ?? 0;
  const failWith = options.failWith;

  return Object.freeze({
    kind: "mock" as const,
    async write(_bytes: Uint8Array, writeOptions?: { timeoutMs?: number }): Promise<void> {
      const timeoutMs = writeOptions?.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
      if (delayMs > timeoutMs) {
        await sleep(timeoutMs);
        throw timeoutError(timeoutMs);
      }
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      if (failWith !== undefined && failWith.length > 0) {
        throw new Error(failWith);
      }
    },
  });
}

/**
 * File-backed USB port: open path, write bytes, close.
 * Use for device nodes / Windows COM / spool files without node-usb.
 * Device paths open `r+` (no truncate); spool files open `w` (create).
 */
export function createFileUsbPort(devicePath: string): UsbPrintPort {
  const path = normalizePrinterPath(devicePath);
  if (path.length === 0) {
    throw new Error("createFileUsbPort requires a non-empty devicePath");
  }

  return Object.freeze({
    kind: "usb" as const,
    async write(bytes: Uint8Array, writeOptions?: { timeoutMs?: number }): Promise<void> {
      const timeoutMs = writeOptions?.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
      await withTimeout(writeBytesToFile(path, bytes), timeoutMs);
    },
  });
}

function openFlagsForPath(devicePath: string): string {
  if (isWindowsDevicePath(devicePath) || isPosixDevicePath(devicePath)) {
    // Device nodes: do not truncate; Windows COM often rejects 'w' truncate.
    return "r+";
  }
  // Spool / redirect files: create or overwrite.
  return "w";
}

async function writeBytesToFile(devicePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(devicePath, openFlagsForPath(devicePath));
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the active USB print port from process env.
 * Non-empty LAUNDRY_PRINTER_PATH → file/device port (kind "usb"); else mock.
 * Path is normalized (COM3 → \\.\COM3, etc.).
 */
export function resolveUsbPrintPort(env: NodeJS.ProcessEnv): UsbPrintPort {
  const raw = env[PRINTER_PATH_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return createFileUsbPort(raw);
  }
  return createMockUsbPort();
}
