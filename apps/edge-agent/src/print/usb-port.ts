/**
 * USB print port adapter (M2 Edge).
 * Mock by default; optional file path via LAUNDRY_PRINTER_PATH (no node-usb).
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

const PRINTER_PATH_ENV = "LAUNDRY_PRINTER_PATH";

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
 * Use for device nodes / spool files (e.g. /dev/usb/lp0) without node-usb.
 */
export function createFileUsbPort(devicePath: string): UsbPrintPort {
  const path = devicePath.trim();
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

async function writeBytesToFile(devicePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(devicePath, "w");
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the active USB print port from process env.
 * Non-empty LAUNDRY_PRINTER_PATH → file port (kind "usb"); else mock.
 */
export function resolveUsbPrintPort(env: NodeJS.ProcessEnv): UsbPrintPort {
  const raw = env[PRINTER_PATH_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return createFileUsbPort(raw.trim());
  }
  return createMockUsbPort();
}
