/**
 * USB print port adapter (M2 Edge).
 * Mock by default; product LAUNDRY_PRINTER_PATH accepts validated device endpoints only.
 * Low-level spool files remain available solely through explicit test/diagnostic injection.
 * Writes never hang forever — timeoutMs is honored via race.
 */

import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";

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

/** Windows device namespace prefix (`\\\\.\`). */
const WIN_DEVICE_NS_PREFIX = /^\\\\\.\\/i;
/** Bare `COM3` / `com12` (Windows serial). */
const BARE_COM = /^com([1-9]\d*)$/i;
/** Bare `LPT1` / `lpt2` (Windows parallel printer port). */
const BARE_LPT = /^lpt([1-9]\d*)$/i;
/** Bare `USB001` (Windows USB printing support virtual port). */
const BARE_USB = /^usb(\d+)$/i;
/** Canonical Windows printer endpoints accepted by production configuration. */
const WIN_PRINTER_DEVICE = /^\\\\\.\\(?:com[1-9]\d*|lpt[1-9]\d*|usb\d+)$/i;
/** POSIX character device under /dev (lp / usb / tty). */
const POSIX_DEV = /^\/dev\//i;

export type PrinterPathStat = Readonly<{
  isCharacterDevice(): boolean;
  isSymbolicLink?(): boolean;
}>;

export type PrinterDeviceHandle = Readonly<{
  stat(): Promise<PrinterPathStat>;
  write(bytes: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
}>;

export type PrinterDeviceDependencies = Readonly<{
  platform?: NodeJS.Platform;
  stat?: (path: string) => PrinterPathStat;
  openDevice?: (path: string, flags: string | number) => Promise<PrinterDeviceHandle>;
}>;

export type FileUsbPortDependencies = Readonly<{
  /** Explicit low-level write injection for timeout/quarantine tests. */
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
}>;

let quarantinedWrite: Promise<void> | null = null;

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
  let didTimeout = false;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          didTimeout = true;
          reject(timeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (didTimeout) {
      const settlement = work.then(
        () => undefined,
        () => undefined,
      );
      quarantinedWrite = settlement;
      void settlement.finally(() => {
        if (quarantinedWrite === settlement) {
          quarantinedWrite = null;
        }
      });
    }
    throw error;
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
  return WIN_PRINTER_DEVICE.test(devicePath.trim());
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

  if (WIN_DEVICE_NS_PREFIX.test(unified)) {
    const rest = unified.slice(4);
    const com = rest.match(BARE_COM);
    if (com) {
      return `\\\\.\\COM${com[1]}`;
    }
    const lpt = rest.match(BARE_LPT);
    if (lpt) {
      return `\\\\.\\LPT${lpt[1]}`;
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
  const bareLpt = unified.match(BARE_LPT);
  if (bareLpt) {
    return `\\\\.\\LPT${bareLpt[1]}`;
  }
  const bareUsb = unified.match(BARE_USB);
  if (bareUsb) {
    return `\\\\.\\USB${bareUsb[1]}`;
  }

  return unified;
}

/** Validate and normalize a production printer endpoint for the target platform. */
export function validatePrinterDevicePath(
  raw: string,
  dependencies: PrinterDeviceDependencies = {},
): string {
  const path = normalizePrinterPath(raw);
  if (path.length === 0) {
    throw new Error("Printer path must not be empty");
  }

  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    if (!isWindowsDevicePath(path)) {
      throw new Error("Windows printer path must be a COM, LPT, or USB device endpoint");
    }
    return path;
  }

  if (path.split("/").includes("..")) {
    throw new Error("POSIX printer path must not contain traversal segments");
  }
  const normalized = posix.normalize(path);
  if (!isPosixDevicePath(normalized)) {
    throw new Error("POSIX printer path must be a character device under /dev");
  }

  const inspect = dependencies.stat ?? lstatSync;
  const inspected = inspect(normalized);
  if (inspected.isSymbolicLink?.() === true) {
    throw new Error("POSIX printer path must not be a symlink");
  }
  if (!inspected.isCharacterDevice()) {
    throw new Error("POSIX printer path must be a character device under /dev");
  }
  return normalized;
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
 * Low-level file/device adapter: open path, write bytes, close.
 * Product env must go through resolveUsbPrintPort validation. Arbitrary spool files
 * are supported only for explicitly injected tests/diagnostics.
 * Device paths open `r+` (no truncate); spool files open `w` (create).
 */
export function createFileUsbPort(
  devicePath: string,
  dependencies: FileUsbPortDependencies = {},
): UsbPrintPort {
  const path = normalizePrinterPath(devicePath);
  if (path.length === 0) {
    throw new Error("createFileUsbPort requires a non-empty devicePath");
  }

  return createUsbPort(path, dependencies.writeBytes ?? writeBytesToFile);
}

function createUsbPort(
  path: string,
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>,
): UsbPrintPort {
  return Object.freeze({
    kind: "usb" as const,
    async write(bytes: Uint8Array, writeOptions?: { timeoutMs?: number }): Promise<void> {
      if (quarantinedWrite !== null) {
        throw new Error("Previous timed-out printer write is still pending");
      }
      const timeoutMs = writeOptions?.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
      await withTimeout(writeBytes(path, bytes), timeoutMs);
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

async function writeBytesToValidatedDevice(
  devicePath: string,
  bytes: Uint8Array,
  dependencies: PrinterDeviceDependencies,
): Promise<void> {
  const validatedPath = validatePrinterDevicePath(devicePath, dependencies);
  const platform = dependencies.platform ?? process.platform;
  const flags = platform === "win32" ? "r+" : constants.O_WRONLY | constants.O_NOFOLLOW;
  const handle =
    dependencies.openDevice !== undefined
      ? await dependencies.openDevice(validatedPath, flags)
      : await open(validatedPath, flags);
  try {
    if (platform !== "win32") {
      const openedTarget = await handle.stat();
      if (!openedTarget.isCharacterDevice()) {
        throw new Error("Opened POSIX printer target must remain a character device");
      }
    }
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the active USB print port from product env.
 * Non-empty LAUNDRY_PRINTER_PATH must be a validated platform device endpoint;
 * arbitrary files, symlinks, traversal and cross-platform endpoint forms fail closed.
 */
export function resolveUsbPrintPort(
  env: NodeJS.ProcessEnv,
  dependencies: PrinterDeviceDependencies = {},
): UsbPrintPort {
  const raw = env[PRINTER_PATH_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const validatedPath = validatePrinterDevicePath(raw, dependencies);
    return createUsbPort(validatedPath, (path, bytes) =>
      writeBytesToValidatedDevice(path, bytes, dependencies),
    );
  }
  return createMockUsbPort();
}
