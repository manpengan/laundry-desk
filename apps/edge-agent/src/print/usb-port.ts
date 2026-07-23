/**
 * USB print port adapter skeleton (M2 Edge).
 * Mock succeeds by default; real node-usb comes later. Never hang forever.
 */

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
        throw new Error(`USB write timed out after ${timeoutMs}ms`);
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
