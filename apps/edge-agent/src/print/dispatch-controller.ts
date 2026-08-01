import type { PrintReceiptSettlement } from "@laundry/contracts";

import type { EdgePrintHttpTransport } from "../desktop/print-http-transport.js";
import type { SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import type { PrintContinuity } from "./continuity.js";
import type { DispatchLedgerEntry } from "./dispatch-ledger-state.js";
import { PrintDispatchLedger } from "./dispatch-ledger.js";
import { createExecutionGate, type ExecutionGate } from "./execution-gate.js";
import { SignedPrintExecutor, type SignedPrintExecution } from "./signed-executor.js";

export type PrintDispatchControllerStatus = Readonly<{
  state: "idle" | "settled" | "receipt_pending" | "unavailable" | "failed";
  job_id: string | null;
  result: SignedExecutionReceipt["payload"]["result"] | null;
  cups_job_id: string | null;
  message: string;
}>;

export type PrintDispatchControllerOptions = Readonly<{
  transport: EdgePrintHttpTransport;
  executor: SignedPrintExecutor;
  ledger: PrintDispatchLedger;
  continuity: PrintContinuity;
  readyToClaim?: () => boolean | Promise<boolean>;
  pollIntervalMs?: number;
  onStatus?: (status: PrintDispatchControllerStatus) => void;
  onError: (error: unknown) => void;
}>;

type UploadResult = "uploaded" | "unavailable" | "mismatch";

function status(
  state: PrintDispatchControllerStatus["state"],
  message: string,
  execution?: SignedPrintExecution,
): PrintDispatchControllerStatus {
  return Object.freeze({
    state,
    job_id: execution?.jobId ?? null,
    result: execution?.receipt.payload.result ?? null,
    cups_job_id: execution?.cupsJobId ?? null,
    message,
  });
}

function settlementMatches(
  receipt: SignedExecutionReceipt,
  settlement: PrintReceiptSettlement,
): boolean {
  const expectedStatus = receipt.payload.result === "succeeded" ? "done" : receipt.payload.result;
  return (
    settlement.job_id === receipt.payload.job_id &&
    settlement.status === expectedStatus &&
    settlement.result === receipt.payload.result &&
    settlement.cups_job_id === receipt.payload.cups_job_id
  );
}

/** Serialized startup recovery, exact receipt replay, claim, execution and settlement. */
export class PrintDispatchController {
  private readonly gate: ExecutionGate = createExecutionGate();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<PrintDispatchControllerStatus> | null = null;
  private recovered = false;

  constructor(private readonly options: PrintDispatchControllerOptions) {
    const interval = options.pollIntervalMs ?? 2_000;
    if (!Number.isSafeInteger(interval) || interval < 250 || interval > 60_000) {
      throw new TypeError("Invalid print dispatch poll interval");
    }
  }

  async start(): Promise<PrintDispatchControllerStatus> {
    if (!this.recovered) {
      await this.options.executor.recoverInterrupted();
      this.recovered = true;
    }
    if (this.timer === null) {
      const interval = this.options.pollIntervalMs ?? 2_000;
      this.timer = setInterval(() => {
        void this.runOnce().catch((error: unknown) => {
          const failed = status("failed", "Signed print polling failed closed");
          this.options.onStatus?.(failed);
          this.options.onError(error);
        });
      }, interval);
      this.timer.unref();
    }
    return this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.gate(async () => undefined);
  }

  runOnce(): Promise<PrintDispatchControllerStatus> {
    if (this.activePoll !== null) return this.activePoll;
    const run = this.gate(async () => {
      const next = await this.poll();
      this.options.onStatus?.(next);
      return next;
    });
    this.activePoll = run;
    const clear = (): void => {
      if (this.activePoll === run) this.activePoll = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private async poll(): Promise<PrintDispatchControllerStatus> {
    for (const pending of await this.options.ledger.pendingReceipts()) {
      const uploaded = await this.uploadEntry(pending);
      if (uploaded === "unavailable") {
        return status("receipt_pending", "Signed print receipt is pending upload");
      }
      if (uploaded === "mismatch") {
        return status("failed", "Print receipt settlement mismatch rejected");
      }
    }

    if ((await this.options.readyToClaim?.()) === false) {
      return status("unavailable", "Pinned print authority is unavailable");
    }

    const continuityToken = this.options.continuity.capture();
    const claim = await this.options.transport.claim();
    if (!this.options.continuity.isCurrent(continuityToken)) {
      return status("unavailable", "Print claim crossed a suspend or resume boundary");
    }
    if (!claim.ok) return status("unavailable", "Print dispatch claim is unavailable");
    if (claim.data === null) return status("idle", "No signed print dispatch is ready");

    let execution: SignedPrintExecution;
    try {
      execution = await this.options.executor.execute({
        dispatch: claim.data,
        staffId: claim.session.session.staff_id,
        timing: claim.timing,
        continuityTrusted: () => this.options.continuity.isCurrent(continuityToken),
      });
    } catch (error) {
      this.options.onError(error);
      return status("failed", "Signed print dispatch was rejected");
    }
    const uploaded = await this.uploadReceipt(execution.receipt);
    if (uploaded === "unavailable") {
      return status("receipt_pending", "Signed print receipt is pending upload", execution);
    }
    if (uploaded === "mismatch") {
      return status("failed", "Print receipt settlement mismatch rejected", execution);
    }
    return status("settled", "Signed print receipt settled", execution);
  }

  private uploadEntry(entry: DispatchLedgerEntry): Promise<UploadResult> {
    if (entry.receipt === null) throw new Error("Pending print receipt disappeared");
    return this.uploadReceipt(entry.receipt);
  }

  private async uploadReceipt(receipt: SignedExecutionReceipt): Promise<UploadResult> {
    const response = await this.options.transport.receipt(receipt);
    if (!response.ok) return "unavailable";
    if (!settlementMatches(receipt, response.data)) return "mismatch";
    await this.options.ledger.markUploaded(receipt.payload.job_id, receipt);
    return "uploaded";
  }
}

export function createPrintDispatchController(
  options: PrintDispatchControllerOptions,
): PrintDispatchController {
  return new PrintDispatchController(options);
}
