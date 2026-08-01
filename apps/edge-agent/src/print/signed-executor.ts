/** Main-process-only signed dispatch → durable ledger → raw CUPS → signed receipt. */
import type { KeyObject } from "node:crypto";

import { CupsJobIdSchema, type ExecutionReceiptPayload } from "@laundry/contracts";

import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { signReceipt, type SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import { CupsSubmissionError } from "./cups-process.js";
import { isCupsQueueName } from "./cups-queue.js";
import {
  type DispatchLedgerBinding,
  type DispatchLedgerEntry,
  PrintDispatchLedger,
} from "./dispatch-ledger.js";
import {
  verifyPrintDispatch,
  type DispatchClaimTiming,
  type VerifiedPrintDispatch,
} from "./dispatch-verifier.js";
import { createExecutionGate, type ExecutionGate } from "./execution-gate.js";
import { renderPrintSnapshot, type RenderedPrintSnapshot } from "./snapshot-render.js";

export type SignedPrintRequest = Readonly<{
  dispatch: unknown;
  staffId: string;
  timing: DispatchClaimTiming;
  continuityTrusted: () => boolean;
}>;

export type SignedPrintExecution = Readonly<{
  jobId: string;
  state: "cups_accepted" | "failed" | "uncertain" | "receipt_pending" | "settled";
  cupsJobId: string | null;
  receipt: SignedExecutionReceipt;
}>;

export type SignedPrintExecutorOptions = Readonly<{
  ledger: PrintDispatchLedger;
  deviceId: string;
  queue: string;
  devicePrivateKey: KeyObject;
  /** Returns only the authority-exchange key already accepted by persistent trust. */
  serverPublicKey: () => KeyObject | null;
  discoverQueues: () => Promise<readonly string[]>;
  submitCups: (queue: string, bytes: Uint8Array) => Promise<string>;
  monotonicNowMs: () => number;
  receiptNow?: () => Date;
  safetyMarginMs?: number;
}>;

function resultState(result: ExecutionReceiptPayload["result"]): SignedPrintExecution["state"] {
  if (result === "succeeded") return "cups_accepted";
  return result;
}

function executionFrom(entry: DispatchLedgerEntry): SignedPrintExecution {
  const receipt = entry.receipt;
  if (receipt === null) throw new Error("Print dispatch has no durable receipt");
  return Object.freeze({
    jobId: entry.binding.jobId,
    state: entry.phase === "receipt_uploaded" ? "settled" : resultState(receipt.payload.result),
    cupsJobId: receipt.payload.cups_job_id,
    receipt,
  });
}

function bindingFrom(
  verified: VerifiedPrintDispatch,
  context: Readonly<{ deviceId: string; staffId: string; queue: string }>,
): DispatchLedgerBinding {
  return Object.freeze({
    jobId: verified.payload.job_id,
    deviceId: context.deviceId,
    staffId: context.staffId,
    origin: APP_CAPABILITY_ORIGIN,
    ticketNonce: verified.payload.nonce,
    printerKind: verified.payload.printer_kind,
    snapshotSha256: verified.payload.snapshot_sha256,
    capabilitySha256: verified.capabilitySha256,
    expectedReceiptSeq: verified.payload.next_receipt_seq,
    queue: context.queue,
  });
}

export class SignedPrintExecutor {
  private readonly gate: ExecutionGate = createExecutionGate();

  constructor(private readonly options: SignedPrintExecutorOptions) {
    if (options.devicePrivateKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("Signed print receipts require an Ed25519 device key");
    }
    if (!isCupsQueueName(options.queue)) throw new TypeError("Invalid signed-print CUPS queue");
  }

  async execute(request: SignedPrintRequest): Promise<SignedPrintExecution> {
    const serverPublicKey = this.options.serverPublicKey();
    if (serverPublicKey === null) throw new Error("Pinned print authority key is unavailable");
    const verified = verifyPrintDispatch(request.dispatch, {
      serverPublicKey,
      deviceId: this.options.deviceId,
      staffId: request.staffId,
      printerKind: "xp58",
      timing: request.timing,
      monotonicNowMs: this.options.monotonicNowMs,
      continuityTrusted: request.continuityTrusted,
      ...(this.options.safetyMarginMs === undefined
        ? {}
        : { safetyMarginMs: this.options.safetyMarginMs }),
    });
    const binding = bindingFrom(verified, {
      deviceId: this.options.deviceId,
      staffId: request.staffId,
      queue: this.options.queue,
    });
    const prepared = await this.options.ledger.prepare(
      binding,
      this.receiptNow().getTime(),
      verified.payload.recovered,
    );
    return this.gate(async () => {
      if (prepared.requiresUncertain) {
        return executionFrom(await this.persistOutcome(prepared.entry, "uncertain", null));
      }
      return this.executeSerialized(verified, request.continuityTrusted);
    });
  }

  async recoverInterrupted(): Promise<readonly SignedPrintExecution[]> {
    const recovered: SignedPrintExecution[] = [];
    for (const entry of await this.options.ledger.uncertainDispatches()) {
      const durable = await this.persistOutcome(entry, "uncertain", null);
      recovered.push(executionFrom(durable));
    }
    return Object.freeze(recovered);
  }

  private receiptNow(): Date {
    const at = this.options.receiptNow?.() ?? new Date();
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid print receipt time");
    return at;
  }

  private async executeSerialized(
    verified: VerifiedPrintDispatch,
    continuityTrusted: () => boolean,
  ): Promise<SignedPrintExecution> {
    const current = await this.options.ledger.get(verified.payload.job_id);
    if (current === null) throw new Error("Prepared print dispatch disappeared");
    if (current.receipt !== null) return executionFrom(current);
    if (current.phase === "submitting") {
      return executionFrom(await this.persistOutcome(current, "uncertain", null));
    }
    let rendered: RenderedPrintSnapshot;
    try {
      if (!continuityTrusted()) throw new Error("monotonic continuity lost");
      if (this.options.monotonicNowMs() >= verified.localDeadlineMonoMs) {
        throw new Error("print dispatch monotonic deadline expired");
      }
      const queues = await this.options.discoverQueues();
      if (!queues.includes(this.options.queue))
        throw new Error("configured CUPS queue unavailable");
      rendered = renderPrintSnapshot(verified.snapshot);
      if (!continuityTrusted() || this.options.monotonicNowMs() >= verified.localDeadlineMonoMs) {
        throw new Error("print dispatch deadline elapsed before CUPS submission");
      }
    } catch {
      return executionFrom(await this.persistOutcome(current, "failed", null));
    }

    const submitting = await this.options.ledger.markSubmitting(verified.payload.job_id);
    try {
      const cupsJobId = CupsJobIdSchema.parse(
        await this.options.submitCups(this.options.queue, rendered.bytes),
      );
      return executionFrom(await this.persistOutcome(submitting, "succeeded", cupsJobId));
    } catch (error) {
      const result = error instanceof CupsSubmissionError ? error.outcome : "uncertain";
      return executionFrom(await this.persistOutcome(submitting, result, null));
    }
  }

  private persistOutcome(
    entry: DispatchLedgerEntry,
    result: ExecutionReceiptPayload["result"],
    cupsJobId: string | null,
  ): Promise<DispatchLedgerEntry> {
    const at = this.receiptNow().toISOString();
    return this.options.ledger.persistReceipt(entry.binding.jobId, (sequence) =>
      signReceipt(
        Object.freeze({
          job_id: entry.binding.jobId,
          device_id: entry.binding.deviceId,
          ticket_nonce: entry.binding.ticketNonce,
          snapshot_sha256: entry.binding.snapshotSha256,
          result,
          cups_job_id: cupsJobId,
          seq: sequence,
          at,
        }),
        this.options.devicePrivateKey,
      ),
    );
  }
}

export function createSignedPrintExecutor(
  options: SignedPrintExecutorOptions,
): SignedPrintExecutor {
  return new SignedPrintExecutor(options);
}
