import {
  runWindowsHelper,
  runWindowsHelperWithInput,
  WindowsHelperSubmissionError,
  type WindowsHelperResult,
} from "./helper-client.js";

const MAXIMUM_QUEUE_LENGTH = 256;

export function isWindowsPrinterQueueName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_QUEUE_LENGTH &&
    value.trim() === value &&
    !value.includes("/") &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export type WindowsPrintDependencies = Readonly<{
  platform?: NodeJS.Platform;
  run?: (arguments_: readonly string[]) => Promise<WindowsHelperResult>;
  runWithInput?: (arguments_: readonly string[], input: Uint8Array) => Promise<WindowsHelperResult>;
}>;

export class WindowsRawSubmissionError extends Error {
  constructor(readonly outcome: "failed" | "uncertain") {
    super(
      outcome === "uncertain"
        ? "WINDOWS_RAW_SUBMISSION_UNCERTAIN"
        : "WINDOWS_RAW_SUBMISSION_FAILED",
    );
    this.name = "WindowsRawSubmissionError";
  }
}

export async function listWindowsPrinters(
  dependencies: WindowsPrintDependencies = {},
): Promise<readonly string[]> {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("WINDOWS_PRINT_PLATFORM_REQUIRED");
  }
  const result = await (dependencies.run ?? runWindowsHelper)(["list-printers"]);
  const printers = result.printers;
  if (!Array.isArray(printers) || !printers.every(isWindowsPrinterQueueName)) {
    throw new Error("WINDOWS_PRINTER_LIST_INVALID");
  }
  return Object.freeze(
    [...new Set(printers)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export type WindowsRawPrintResult = Readonly<{ jobId: string; bytesWritten: number }>;

export async function submitWindowsRaw(
  queue: string,
  bytes: Uint8Array,
  dependencies: WindowsPrintDependencies = {},
): Promise<WindowsRawPrintResult> {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("WINDOWS_PRINT_PLATFORM_REQUIRED");
  }
  if (!isWindowsPrinterQueueName(queue)) throw new Error("WINDOWS_PRINT_QUEUE_INVALID");
  let result: WindowsHelperResult;
  try {
    result = await (dependencies.runWithInput ?? runWindowsHelperWithInput)(
      ["print-raw", queue],
      Uint8Array.from(bytes),
    );
  } catch (error) {
    if (error instanceof WindowsHelperSubmissionError) {
      throw new WindowsRawSubmissionError(error.outcome);
    }
    throw new WindowsRawSubmissionError("uncertain");
  }
  const jobId = result.job_id;
  const bytesWritten = result.bytes_written;
  if (
    !Number.isSafeInteger(jobId) ||
    (jobId as number) < 1 ||
    !Number.isSafeInteger(bytesWritten) ||
    bytesWritten !== bytes.byteLength
  ) {
    throw new WindowsRawSubmissionError("uncertain");
  }
  return Object.freeze({ jobId: String(jobId), bytesWritten: bytesWritten as number });
}
