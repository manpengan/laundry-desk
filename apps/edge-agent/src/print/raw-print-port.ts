import { PrintJobReferenceSchema } from "@laundry/contracts";
import {
  isWindowsPrinterQueueName,
  listWindowsPrinters,
  submitWindowsRaw,
  WindowsRawSubmissionError,
} from "@laundry/platform-fs";

import { CupsSubmissionError, discoverCupsQueues, submitCupsBytes } from "./cups-process.js";
import { isCupsQueueName } from "./cups-queue.js";

export type RawPrintSubmissionOutcome = "failed" | "uncertain";

export class RawPrintSubmissionError extends Error {
  constructor(readonly outcome: RawPrintSubmissionOutcome) {
    super(
      outcome === "uncertain" ? "RAW_PRINT_SUBMISSION_UNCERTAIN" : "RAW_PRINT_SUBMISSION_FAILED",
    );
    this.name = "RawPrintSubmissionError";
  }
}

export type RawPrintPort = Readonly<{
  backend: "cups" | "windows_spooler";
  isQueueName: (queue: string) => boolean;
  discoverQueues: () => Promise<readonly string[]>;
  submitRaw: (queue: string, bytes: Uint8Array) => Promise<string>;
}>;

export type RawPrintPortDependencies = Readonly<{
  discoverCups?: () => Promise<readonly string[]>;
  submitCups?: (queue: string, bytes: Uint8Array) => Promise<string>;
  discoverWindows?: () => Promise<readonly string[]>;
  submitWindows?: (
    queue: string,
    bytes: Uint8Array,
  ) => Promise<Readonly<{ jobId: string; bytesWritten: number }>>;
}>;

export function createCupsRawPrintPort(dependencies: RawPrintPortDependencies = {}): RawPrintPort {
  return Object.freeze({
    backend: "cups" as const,
    isQueueName: isCupsQueueName,
    discoverQueues: dependencies.discoverCups ?? discoverCupsQueues,
    submitRaw: async (queue: string, bytes: Uint8Array) => {
      try {
        return PrintJobReferenceSchema.parse(
          await (dependencies.submitCups ?? submitCupsBytes)(queue, bytes),
        );
      } catch (error) {
        if (error instanceof CupsSubmissionError) {
          throw new RawPrintSubmissionError(error.outcome);
        }
        throw new RawPrintSubmissionError("uncertain");
      }
    },
  });
}

export function createWindowsRawPrintPort(
  dependencies: RawPrintPortDependencies = {},
): RawPrintPort {
  return Object.freeze({
    backend: "windows_spooler" as const,
    isQueueName: isWindowsPrinterQueueName,
    discoverQueues: dependencies.discoverWindows ?? listWindowsPrinters,
    submitRaw: async (queue: string, bytes: Uint8Array) => {
      try {
        const result = await (dependencies.submitWindows ?? submitWindowsRaw)(queue, bytes);
        if (result.bytesWritten !== bytes.byteLength || !/^[1-9][0-9]*$/u.test(result.jobId)) {
          throw new RawPrintSubmissionError("uncertain");
        }
        return PrintJobReferenceSchema.parse(`winspool-${result.jobId}`);
      } catch (error) {
        if (error instanceof RawPrintSubmissionError) throw error;
        if (error instanceof WindowsRawSubmissionError) {
          throw new RawPrintSubmissionError(error.outcome);
        }
        throw new RawPrintSubmissionError("uncertain");
      }
    },
  });
}

export function createPlatformRawPrintPort(
  platform: NodeJS.Platform = process.platform,
  dependencies: RawPrintPortDependencies = {},
): RawPrintPort {
  if (platform === "darwin") return createCupsRawPrintPort(dependencies);
  if (platform === "win32") return createWindowsRawPrintPort(dependencies);
  throw new Error("RAW_PRINT_PLATFORM_UNSUPPORTED");
}
