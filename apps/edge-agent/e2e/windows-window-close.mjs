const CLOSE_RPC_TERMINATED =
  /^(?:electronApplication\.evaluate: )?(?:Execution context was destroyed, most likely because of a navigation\.|Target page, context or browser has been closed)$/u;

/**
 * A real window.close() can terminate Electron before evaluate's RPC acknowledges.
 * Only that RPC may lose its context, and the application's close event is mandatory.
 * @param {{on(event: "close", listener: () => void): unknown, off(event: "close", listener: () => void): unknown}} application
 * @param {() => Promise<unknown>} requestWindowClose
 * @param {number} timeoutMs
 */
export async function closeWindowAndWaitForApplication(
  application,
  requestWindowClose,
  timeoutMs = 15_000,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new Error("WINDOWS_WINDOW_CLOSE_TIMEOUT_INVALID");
  }
  /** @type {(() => void) | undefined} */
  let onClose;
  const closed = new Promise((resolve) => {
    onClose = () => resolve(undefined);
    application.on("close", onClose);
  });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const requested = requestWindowClose().catch((error) => {
      if (!(error instanceof Error) || !CLOSE_RPC_TERMINATED.test(error.message)) throw error;
    });
    await Promise.race([
      Promise.all([closed, requested]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("WINDOWS_WINDOW_CLOSE_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onClose !== undefined) application.off("close", onClose);
  }
}
