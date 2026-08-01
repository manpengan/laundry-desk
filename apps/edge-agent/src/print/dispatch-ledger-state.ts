import { createHash } from "node:crypto";
import { z } from "zod";

import {
  EdgePrinterKindSchema,
  ExecutionReceiptPayloadSchema,
  Sha256HexSchema,
} from "@laundry/contracts";

import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import type { SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import { CUPS_QUEUE_NAME_PATTERN } from "./cups-queue.js";

const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const FILTER_BYTES = 64 * 1024;
const FILTER_BITS = FILTER_BYTES * 8;
const FILTER_HASHES = 4;
export const MAX_LEDGER_RECORDS = 5_000;
export const DEFAULT_RETAINED_UPLOADED = 256;

const SignedReceiptSchema = z.strictObject({
  protocol_version: z.string().regex(SEMVER),
  payload: ExecutionReceiptPayloadSchema,
  sig: z.string().regex(SIGNATURE),
});

export const DispatchRecordSchema = z
  .strictObject({
    job_id: z.uuid(),
    device_id: z.uuid(),
    staff_id: z.uuid(),
    origin: z.literal(APP_CAPABILITY_ORIGIN),
    ticket_nonce: z.uuid(),
    printer_kind: EdgePrinterKindSchema,
    snapshot_sha256: Sha256HexSchema,
    capability_sha256: Sha256HexSchema,
    expected_receipt_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    queue: z.string().regex(CUPS_QUEUE_NAME_PATTERN),
    phase: z.enum(["prepared", "submitting", "receipt_pending", "receipt_uploaded"]),
    receipt: SignedReceiptSchema.nullable(),
    updated_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((record, context) => {
    const terminal = record.phase === "receipt_pending" || record.phase === "receipt_uploaded";
    if (terminal !== (record.receipt !== null)) {
      context.addIssue({ code: "custom", message: "Ledger receipt phase is inconsistent" });
      return;
    }
    const receipt = record.receipt?.payload;
    if (
      receipt !== undefined &&
      (receipt.job_id !== record.job_id ||
        receipt.device_id !== record.device_id ||
        receipt.ticket_nonce !== record.ticket_nonce ||
        receipt.snapshot_sha256 !== record.snapshot_sha256 ||
        receipt.seq !== record.expected_receipt_seq)
    ) {
      context.addIssue({ code: "custom", message: "Ledger receipt binding is inconsistent" });
    }
  });

const ReplayFilterSchema = z.base64().superRefine((value, context) => {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== FILTER_BYTES || bytes.toString("base64") !== value) {
    context.addIssue({ code: "custom", message: "Invalid settled replay filter" });
  }
});

const DispatchLedgerStateSchema = z
  .strictObject({
    version: z.literal(1),
    next_receipt_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    compacted_receipt_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    settled_replay_filter: ReplayFilterSchema,
    records: z.array(DispatchRecordSchema).max(MAX_LEDGER_RECORDS),
  })
  .superRefine((state, context) => {
    const jobs = state.records.map((record) => record.job_id);
    const nonces = state.records.map((record) => record.ticket_nonce);
    if (new Set(jobs).size !== jobs.length || new Set(nonces).size !== nonces.length) {
      context.addIssue({ code: "custom", message: "Ledger bindings must be unique" });
    }
    const sequences = state.records.flatMap((record) =>
      record.receipt === null ? [] : [record.receipt.payload.seq],
    );
    if (
      state.compacted_receipt_seq >= state.next_receipt_seq ||
      sequences.some((sequence) => sequence >= state.next_receipt_seq) ||
      new Set(sequences).size !== sequences.length
    ) {
      context.addIssue({ code: "custom", message: "Ledger receipt sequence is invalid" });
    }
  });

type ParsedState = z.output<typeof DispatchLedgerStateSchema>;
export type DispatchRecord = Readonly<ParsedState["records"][number]>;
export type DispatchLedgerState = Readonly<{
  version: 1;
  next_receipt_seq: number;
  compacted_receipt_seq: number;
  settled_replay_filter: string;
  records: readonly DispatchRecord[];
}>;
export type PrinterKind = z.output<typeof EdgePrinterKindSchema>;
export type DispatchLedgerBinding = Readonly<{
  jobId: string;
  deviceId: string;
  staffId: string;
  origin: string;
  ticketNonce: string;
  printerKind: PrinterKind;
  snapshotSha256: string;
  capabilitySha256: string;
  expectedReceiptSeq: number;
  queue: string;
}>;
export type DispatchLedgerEntry = Readonly<{
  binding: DispatchLedgerBinding;
  phase: DispatchRecord["phase"];
  receipt: SignedExecutionReceipt | null;
}>;

export const EMPTY_LEDGER_STATE: DispatchLedgerState = Object.freeze({
  version: 1,
  next_receipt_seq: 1,
  compacted_receipt_seq: 0,
  settled_replay_filter: Buffer.alloc(FILTER_BYTES).toString("base64"),
  records: Object.freeze([]),
});

export function freezeLedgerState(input: unknown): DispatchLedgerState {
  const parsed = DispatchLedgerStateSchema.parse(input);
  return Object.freeze({
    version: 1,
    next_receipt_seq: parsed.next_receipt_seq,
    compacted_receipt_seq: parsed.compacted_receipt_seq,
    settled_replay_filter: parsed.settled_replay_filter,
    records: Object.freeze(
      parsed.records.map((record) =>
        Object.freeze({
          ...record,
          receipt:
            record.receipt === null
              ? null
              : Object.freeze({
                  ...record.receipt,
                  payload: Object.freeze({ ...record.receipt.payload }),
                }),
        }),
      ),
    ),
  });
}

export function bindingFrom(record: DispatchRecord): DispatchLedgerBinding {
  return Object.freeze({
    jobId: record.job_id,
    deviceId: record.device_id,
    staffId: record.staff_id,
    origin: record.origin,
    ticketNonce: record.ticket_nonce,
    printerKind: record.printer_kind,
    snapshotSha256: record.snapshot_sha256,
    capabilitySha256: record.capability_sha256,
    expectedReceiptSeq: record.expected_receipt_seq,
    queue: record.queue,
  });
}

export function entryFrom(record: DispatchRecord): DispatchLedgerEntry {
  return Object.freeze({
    binding: bindingFrom(record),
    phase: record.phase,
    receipt: record.receipt,
  });
}

export function stableBindingMatches(
  record: DispatchRecord,
  binding: DispatchLedgerBinding,
): boolean {
  return (
    record.job_id === binding.jobId &&
    record.device_id === binding.deviceId &&
    record.staff_id === binding.staffId &&
    record.origin === binding.origin &&
    record.ticket_nonce === binding.ticketNonce &&
    record.printer_kind === binding.printerKind &&
    record.snapshot_sha256 === binding.snapshotSha256 &&
    record.queue === binding.queue
  );
}

export function exactReceipt(left: SignedExecutionReceipt, right: SignedExecutionReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function filterIndexes(kind: "job" | "nonce", value: string): readonly number[] {
  const digest = createHash("sha256").update(`${kind}\0${value}`, "utf8").digest();
  return Object.freeze(
    Array.from(
      { length: FILTER_HASHES },
      (_, index) => digest.readUInt32BE(index * 4) % FILTER_BITS,
    ),
  );
}

function filterContains(filter: Buffer, kind: "job" | "nonce", value: string): boolean {
  return filterIndexes(kind, value).every((bit) => (filter[bit >>> 3]! & (1 << (bit & 7))) !== 0);
}

export function mayContainCompactedBinding(
  state: DispatchLedgerState,
  binding: DispatchLedgerBinding,
): boolean {
  const filter = Buffer.from(state.settled_replay_filter, "base64");
  return (
    filterContains(filter, "job", binding.jobId) ||
    filterContains(filter, "nonce", binding.ticketNonce)
  );
}

function addFilterBinding(filter: Buffer, record: DispatchRecord): void {
  for (const [kind, value] of [
    ["job", record.job_id],
    ["nonce", record.ticket_nonce],
  ] as const) {
    for (const bit of filterIndexes(kind, value)) {
      const byte = bit >>> 3;
      filter[byte] = filter[byte]! | (1 << (bit & 7));
    }
  }
}

export function compactUploadedRecords(
  state: DispatchLedgerState,
  retain: number,
): DispatchLedgerState {
  const uploaded = state.records
    .filter((record) => record.phase === "receipt_uploaded" && record.receipt !== null)
    .sort((left, right) => left.receipt!.payload.seq - right.receipt!.payload.seq);
  if (uploaded.length <= retain) return state;
  const removed = uploaded.slice(0, uploaded.length - retain);
  const removedJobs = new Set(removed.map((record) => record.job_id));
  const filter = Buffer.from(state.settled_replay_filter, "base64");
  for (const record of removed) addFilterBinding(filter, record);
  return freezeLedgerState({
    ...state,
    compacted_receipt_seq: Math.max(
      state.compacted_receipt_seq,
      ...removed.map((record) => record.receipt!.payload.seq),
    ),
    settled_replay_filter: filter.toString("base64"),
    records: state.records.filter((record) => !removedJobs.has(record.job_id)),
  });
}

function filterIsSuperset(previous: string, observed: string): boolean {
  const left = Buffer.from(previous, "base64");
  const right = Buffer.from(observed, "base64");
  return left.every((value, index) => (value & right[index]!) === value);
}

export function assertLedgerNotRolledBack(
  previous: DispatchLedgerState,
  observed: DispatchLedgerState,
): void {
  if (
    observed.next_receipt_seq < previous.next_receipt_seq ||
    observed.compacted_receipt_seq < previous.compacted_receipt_seq ||
    !filterIsSuperset(previous.settled_replay_filter, observed.settled_replay_filter)
  ) {
    throw new Error("Print receipt sequence rollback detected");
  }
  const rank = { prepared: 0, submitting: 1, receipt_pending: 2, receipt_uploaded: 3 } as const;
  for (const old of previous.records) {
    const current = observed.records.find((record) => record.job_id === old.job_id);
    if (current === undefined || rank[current.phase] < rank[old.phase]) {
      throw new Error("Print dispatch ledger rollback detected");
    }
    const comparable = { ...old, phase: current.phase, updated_at: current.updated_at };
    if (
      old.receipt !== null &&
      (current.receipt === null || !exactReceipt(old.receipt, current.receipt))
    ) {
      throw new Error("Print receipt rollback detected");
    }
    if (JSON.stringify(comparable) !== JSON.stringify(current)) {
      throw new Error("Print dispatch ledger binding changed");
    }
  }
}
