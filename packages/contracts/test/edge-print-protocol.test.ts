import { describe, expect, it } from "vitest";

import {
  PrintDispatchClaimRequestSchema,
  PrintExecutionReceiptRequestSchema,
  PrintJobReferenceSchema,
  PrintSnapshotSchema,
  PrinterQueueNameSchema,
  canonicalizePrintSnapshot,
  parseDeviceSignatureExecutionReceiptCandidate,
  parseServerSignatureCapabilityTicketCandidate,
} from "../src/index.js";

const SHA256 = "a".repeat(64);
const SNAPSHOT = Object.freeze({
  version: 1,
  store_name: "测试洗衣店",
  store_phone: null,
  order_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
  ticket_no: "20260801-0001",
  received_at: "2026-08-01T01:02:03.000Z",
  customer_name: "张三",
  customer_phone: "13800000000",
  note: null,
  lines: Object.freeze([
    Object.freeze({
      line_index: 0,
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 1200,
      qty: 2,
      line_total_cents: 2400,
      color: "白",
      brand: null,
    }),
  ]),
  totals: Object.freeze({
    original_cents: 2400,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 2400,
    paid_cents: 1000,
    balance_cents: 1400,
  }),
  payment_methods: Object.freeze(["cash"]),
});

const CAPABILITY = Object.freeze({
  protocol_version: "1.0.0",
  payload: Object.freeze({
    action: "print_job",
    print_action: "enqueue",
    source_job_id: null,
    job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    origin: "app://local",
    printer_kind: "xp58",
    snapshot_sha256: SHA256,
    recovered: false,
    next_receipt_seq: 7,
    issued_at: "2026-08-01T01:02:03.000Z",
    exp: "2026-08-01T01:03:03.000Z",
    nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  }),
  sig: "Wm9kX2Nhbm9uaWNhbF9zaWduYXR1cmVfZm9yX2VkZ2VfYnJpZGdl",
});

const RECEIPT = Object.freeze({
  protocol_version: "1.0.0",
  payload: Object.freeze({
    job_id: CAPABILITY.payload.job_id,
    device_id: CAPABILITY.payload.device_id,
    ticket_nonce: CAPABILITY.payload.nonce,
    snapshot_sha256: SHA256,
    result: "uncertain",
    cups_job_id: null,
    seq: 7,
    at: "2026-08-01T01:02:05.000Z",
  }),
  sig: "RGV2aWNlX3NpZ25hdHVyZV9mb3JfZXhlY3V0aW9uX3JlY2VpcHQ",
});

describe("Stage3 signed print dispatch protocol", () => {
  it("accepts one immutable real-order snapshot and canonicalizes it deterministically", () => {
    expect(PrintSnapshotSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(canonicalizePrintSnapshot({ ...SNAPSHOT })).toEqual(canonicalizePrintSnapshot(SNAPSHOT));
  });

  it("binds capability and receipt to printer, snapshot, job, device and nonce", () => {
    expect(parseServerSignatureCapabilityTicketCandidate(CAPABILITY).payload).toMatchObject({
      printer_kind: "xp58",
      print_action: "enqueue",
      source_job_id: null,
      snapshot_sha256: SHA256,
      recovered: false,
      next_receipt_seq: 7,
    });
    expect(parseDeviceSignatureExecutionReceiptCandidate(RECEIPT).payload).toEqual(RECEIPT.payload);
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...CAPABILITY,
        payload: { ...CAPABILITY.payload, next_receipt_seq: 0 },
      }),
    ).toThrow();
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...CAPABILITY,
        payload: { ...CAPABILITY.payload, print_action: "retry" },
      }),
    ).toThrow();
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...CAPABILITY,
        payload: { ...CAPABILITY.payload, source_job_id: CAPABILITY.payload.job_id },
      }),
    ).toThrow();
    const withoutPrintAction = { ...CAPABILITY.payload } as Record<string, unknown>;
    delete withoutPrintAction.print_action;
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...CAPABILITY,
        payload: withoutPrintAction,
      }),
    ).toThrow();
    const withoutRecovery = { ...CAPABILITY.payload } as Record<string, unknown>;
    delete withoutRecovery.recovered;
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...CAPABILITY,
        payload: withoutRecovery,
      }),
    ).toThrow();
  });

  it("requires a bounded spooler job reference after definite success", () => {
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...RECEIPT,
        payload: { ...RECEIPT.payload, result: "succeeded" },
      }),
    ).toThrow();
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...RECEIPT,
        payload: { ...RECEIPT.payload, result: "failed", cups_job_id: "xp58-42" },
      }),
    ).toThrow();
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...RECEIPT,
        payload: { ...RECEIPT.payload, result: "uncertain", cups_job_id: "xp58-42" },
      }),
    ).not.toThrow();
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...RECEIPT,
        payload: { ...RECEIPT.payload, cups_job_id: "bad id with spaces" },
      }),
    ).toThrow();
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...RECEIPT,
        payload: { ...RECEIPT.payload, cups_job_id: "xp58" },
      }),
    ).toThrow();
  });

  it("accepts discovered Windows display names without accepting paths or controls", () => {
    expect(PrinterQueueNameSchema.parse("XP-58 宏发前台")).toBe("XP-58 宏发前台");
    expect(() => PrinterQueueNameSchema.parse("../XP58")).toThrow();
    expect(() => PrinterQueueNameSchema.parse("XP58\nRAW")).toThrow();
    expect(PrintJobReferenceSchema.parse("winspool-42")).toBe("winspool-42");
  });

  it("keeps claim and receipt ingress strict and main-process sized", () => {
    expect(
      PrintDispatchClaimRequestSchema.parse({ supported_printer_kinds: ["xp58", "dl206"] }),
    ).toEqual({ supported_printer_kinds: ["xp58", "dl206"] });
    expect(() =>
      PrintDispatchClaimRequestSchema.parse({
        supported_printer_kinds: ["xp58", "xp58"],
      }),
    ).toThrow();
    expect(PrintExecutionReceiptRequestSchema.parse({ receipt: RECEIPT })).toEqual({
      receipt: RECEIPT,
    });
    expect(() =>
      PrintExecutionReceiptRequestSchema.parse({
        receipt: RECEIPT,
        device_id: RECEIPT.payload.device_id,
      }),
    ).toThrow();
  });
});
