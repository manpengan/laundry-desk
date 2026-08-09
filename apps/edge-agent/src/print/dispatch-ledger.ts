import type { SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import {
  assertLedgerNotRolledBack,
  compactUploadedRecords,
  DEFAULT_RETAINED_UPLOADED,
  DispatchRecordSchema,
  EMPTY_LEDGER_STATE,
  entryFrom,
  exactReceipt,
  freezeLedgerState,
  isAuthoritativePrintLineage,
  MAX_LEDGER_RECORDS,
  mayContainCompactedBinding,
  stableBindingMatches,
  type DispatchLedgerBinding,
  type DispatchLedgerEntry,
  type DispatchLedgerState,
} from "./dispatch-ledger-state.js";
import { DurableJsonFile } from "./durable-json-file.js";

export type {
  DispatchLedgerBinding,
  DispatchLedgerEntry,
  PersistedPrintJobAction,
  PrinterKind,
} from "./dispatch-ledger-state.js";

type PreparedDispatchLedgerEntry = Readonly<{
  entry: DispatchLedgerEntry;
  created: boolean;
  requiresUncertain: boolean;
}>;

export class PrintDispatchLedger {
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: DurableJsonFile<DispatchLedgerState>,
    private readonly retainedUploaded: number,
    private state: DispatchLedgerState,
  ) {}

  static async open(
    rootPath: string,
    options: Readonly<{
      randomStagingId?: () => string;
      retainedUploaded?: number;
    }> = {},
  ): Promise<PrintDispatchLedger> {
    const retainedUploaded = options.retainedUploaded ?? DEFAULT_RETAINED_UPLOADED;
    if (
      !Number.isSafeInteger(retainedUploaded) ||
      retainedUploaded < 1 ||
      retainedUploaded > 1_000
    ) {
      throw new Error("Invalid uploaded print-record retention");
    }
    const file = await DurableJsonFile.open({
      rootPath,
      fileName: "print-dispatch-ledger.json",
      maxBytes: 2 * 1024 * 1024,
      parse: freezeLedgerState,
      ...(options.randomStagingId === undefined
        ? {}
        : { randomStagingId: options.randomStagingId }),
    });
    return new PrintDispatchLedger(
      file,
      retainedUploaded,
      (await file.read()) ?? EMPTY_LEDGER_STATE,
    );
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async replace(next: DispatchLedgerState): Promise<void> {
    const frozen = freezeLedgerState(next);
    await this.file.write(frozen);
    this.state = frozen;
  }

  private async refreshCurrent(): Promise<void> {
    const observed = (await this.file.read()) ?? EMPTY_LEDGER_STATE;
    assertLedgerNotRolledBack(this.state, observed);
    this.state = observed;
  }

  prepare(
    binding: DispatchLedgerBinding,
    now = Date.now(),
    recovered = false,
  ): Promise<PreparedDispatchLedgerEntry> {
    return this.exclusive(async () => {
      await this.refreshCurrent();
      if (!isAuthoritativePrintLineage(binding.printAction, binding.sourceJobId)) {
        throw new Error("Print dispatch lineage is not authoritative");
      }
      const parsed = DispatchRecordSchema.parse({
        job_id: binding.jobId,
        device_id: binding.deviceId,
        staff_id: binding.staffId,
        origin: binding.origin,
        ticket_nonce: binding.ticketNonce,
        printer_kind: binding.printerKind,
        print_action: binding.printAction,
        source_job_id: binding.sourceJobId,
        snapshot_sha256: binding.snapshotSha256,
        capability_sha256: binding.capabilitySha256,
        expected_receipt_seq: binding.expectedReceiptSeq,
        queue: binding.queue,
        phase: "prepared",
        receipt: null,
        updated_at: now,
      });
      const existing = this.state.records.find(
        (record) => record.job_id === binding.jobId || record.ticket_nonce === binding.ticketNonce,
      );
      if (existing !== undefined) {
        if (!stableBindingMatches(existing, binding)) {
          throw new Error("Print dispatch collision rejected");
        }
        if (existing.receipt !== null) {
          if (existing.expected_receipt_seq !== binding.expectedReceiptSeq) {
            throw new Error("Print receipt sequence collision rejected");
          }
          return Object.freeze({
            entry: entryFrom(existing),
            created: false,
            requiresUncertain: false,
          });
        }
        if (binding.expectedReceiptSeq < this.state.next_receipt_seq) {
          throw new Error("Print receipt sequence does not match signed authority");
        }
        if (
          existing.expected_receipt_seq !== binding.expectedReceiptSeq ||
          binding.expectedReceiptSeq > this.state.next_receipt_seq
        ) {
          if (!recovered) throw new Error("Print receipt sequence does not match signed authority");
          const resynchronized = Object.freeze({
            ...existing,
            ...(existing.phase === "prepared" && existing.print_action === "unknown"
              ? {
                  print_action: binding.printAction,
                  source_job_id: binding.sourceJobId,
                }
              : {}),
            capability_sha256: binding.capabilitySha256,
            expected_receipt_seq: binding.expectedReceiptSeq,
            updated_at: now,
          });
          await this.replace({
            ...this.state,
            next_receipt_seq: binding.expectedReceiptSeq,
            records: this.state.records.map((record) =>
              record.job_id === existing.job_id ? resynchronized : record,
            ),
          });
          return Object.freeze({
            entry: entryFrom(resynchronized),
            created: false,
            requiresUncertain: true,
          });
        }
        if (
          existing.phase === "prepared" &&
          (existing.capability_sha256 !== binding.capabilitySha256 ||
            existing.print_action === "unknown")
        ) {
          const refreshed = Object.freeze({
            ...existing,
            print_action: binding.printAction,
            source_job_id: binding.sourceJobId,
            capability_sha256: binding.capabilitySha256,
            updated_at: now,
          });
          await this.replace({
            ...this.state,
            records: this.state.records.map((record) =>
              record.job_id === existing.job_id ? refreshed : record,
            ),
          });
          return Object.freeze({
            entry: entryFrom(refreshed),
            created: false,
            requiresUncertain: false,
          });
        }
        return Object.freeze({
          entry: entryFrom(existing),
          created: false,
          requiresUncertain: false,
        });
      }
      if (mayContainCompactedBinding(this.state, binding)) {
        throw new Error("Compacted print dispatch replay rejected");
      }
      if (
        binding.expectedReceiptSeq < this.state.next_receipt_seq ||
        (!recovered && binding.expectedReceiptSeq !== this.state.next_receipt_seq)
      ) {
        throw new Error("Print receipt sequence does not match signed authority");
      }
      if (this.state.records.length >= MAX_LEDGER_RECORDS) {
        throw new Error("Print dispatch ledger active capacity exhausted");
      }
      await this.replace({
        ...this.state,
        next_receipt_seq: binding.expectedReceiptSeq,
        records: [...this.state.records, parsed],
      });
      return Object.freeze({
        entry: entryFrom(parsed),
        created: true,
        requiresUncertain: recovered,
      });
    });
  }

  get(jobId: string): Promise<DispatchLedgerEntry | null> {
    return this.exclusive(async () => {
      await this.refreshCurrent();
      const current = this.state.records.find((record) => record.job_id === jobId);
      return current === undefined ? null : entryFrom(current);
    });
  }

  markSubmitting(jobId: string, now = Date.now()): Promise<DispatchLedgerEntry> {
    return this.exclusive(async () => {
      await this.refreshCurrent();
      const current = this.state.records.find((record) => record.job_id === jobId);
      if (current === undefined || current.phase !== "prepared") {
        throw new Error("Print dispatch is not prepared");
      }
      if (current.expected_receipt_seq !== this.state.next_receipt_seq) {
        throw new Error("Print receipt sequence does not match signed authority");
      }
      const next = Object.freeze({ ...current, phase: "submitting" as const, updated_at: now });
      await this.replace({
        ...this.state,
        records: this.state.records.map((record) => (record.job_id === jobId ? next : record)),
      });
      return entryFrom(next);
    });
  }

  persistReceipt(
    jobId: string,
    create: (sequence: number) => SignedExecutionReceipt,
  ): Promise<DispatchLedgerEntry> {
    return this.exclusive(async () => {
      await this.refreshCurrent();
      const current = this.state.records.find((record) => record.job_id === jobId);
      if (current === undefined) throw new Error("Unknown print dispatch");
      if (current.receipt !== null) return entryFrom(current);
      if (current.phase !== "prepared" && current.phase !== "submitting") {
        throw new Error("Print dispatch cannot persist a receipt");
      }
      if (current.expected_receipt_seq !== this.state.next_receipt_seq) {
        throw new Error("Print receipt sequence does not match signed authority");
      }
      const receipt = create(this.state.next_receipt_seq);
      if (
        receipt.payload.seq !== this.state.next_receipt_seq ||
        receipt.payload.job_id !== current.job_id ||
        receipt.payload.device_id !== current.device_id ||
        receipt.payload.ticket_nonce !== current.ticket_nonce ||
        receipt.payload.snapshot_sha256 !== current.snapshot_sha256
      ) {
        throw new Error("Print receipt binding rejected");
      }
      const next = DispatchRecordSchema.parse({
        ...current,
        phase: "receipt_pending",
        receipt,
        updated_at: Date.parse(receipt.payload.at),
      });
      await this.replace({
        ...this.state,
        next_receipt_seq: this.state.next_receipt_seq + 1,
        records: this.state.records.map((record) => (record.job_id === jobId ? next : record)),
      });
      return entryFrom(next);
    });
  }

  markUploaded(jobId: string, receipt: SignedExecutionReceipt): Promise<DispatchLedgerEntry> {
    return this.exclusive(async () => {
      await this.refreshCurrent();
      const current = this.state.records.find((record) => record.job_id === jobId);
      if (current?.receipt === null || current?.receipt === undefined) {
        throw new Error("Print receipt is not pending");
      }
      if (!exactReceipt(current.receipt, receipt))
        throw new Error("Print receipt collision rejected");
      if (current.phase === "receipt_uploaded") return entryFrom(current);
      if (current.phase !== "receipt_pending") throw new Error("Print receipt is not pending");
      const uploaded = Object.freeze({ ...current, phase: "receipt_uploaded" as const });
      const nextState = compactUploadedRecords(
        freezeLedgerState({
          ...this.state,
          records: this.state.records.map((record) =>
            record.job_id === jobId ? uploaded : record,
          ),
        }),
        this.retainedUploaded,
      );
      await this.replace(nextState);
      return entryFrom(uploaded);
    });
  }

  pendingReceipts(): Promise<readonly DispatchLedgerEntry[]> {
    return this.entries((record) => record.phase === "receipt_pending");
  }

  uncertainDispatches(): Promise<readonly DispatchLedgerEntry[]> {
    return this.entries((record) => record.phase === "prepared" || record.phase === "submitting");
  }

  private entries(predicate: (record: DispatchLedgerState["records"][number]) => boolean) {
    return this.exclusive(async () => {
      await this.refreshCurrent();
      return Object.freeze(this.state.records.filter(predicate).map(entryFrom));
    });
  }
}
