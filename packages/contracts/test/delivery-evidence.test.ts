import { describe, expect, it } from "vitest";

import {
  DELIVERY_EVIDENCE_COMMAND_NAMES,
  DELIVERY_EVIDENCE_QUERY_NAMES,
  DeliveryEvidenceConfirmationSummarySchema,
  DeliveryEvidenceRecordInputSchema,
  M2_READ_ONLY_AI_DEFINITIONS,
  deliveryEvidenceListQuery,
  deliveryEvidenceRecordCommand,
} from "../src/index.js";

const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const STAFF = "44444444-4444-4444-8444-444444444444";
const PHOTO = "55555555-5555-4555-8555-555555555555";
const STORE = "66666666-6666-4666-8666-666666666666";

const pickup = Object.freeze({
  delivery_evidence_id: EVIDENCE,
  delivery_order_id: ORDER,
  delivery_task_id: TASK,
  leg: "pickup" as const,
  expected_delivery_order_version: 3,
  expected_delivery_task_version: 2,
  event_kind: "pickup" as const,
  outcome: "complete_leg" as const,
  captured_at: 1_800_000_000,
  gps: Object.freeze({
    latitude_e7: 251_234_567,
    longitude_e7: 1_215_678_901,
    accuracy_mm: 5_000,
    captured_at: 1_800_000_000,
  }),
  attachment_ids: Object.freeze([PHOTO]),
});

describe("delivery evidence contracts", () => {
  it("freezes one online write and one bounded sensitive read outside AI projection", () => {
    expect(DELIVERY_EVIDENCE_COMMAND_NAMES).toEqual(["delivery.evidence.record"]);
    expect(DELIVERY_EVIDENCE_QUERY_NAMES).toEqual(["delivery.evidence.list"]);
    expect(deliveryEvidenceRecordCommand.invariants).toContain("rbac.delivery_write");
    expect(deliveryEvidenceListQuery.invariants).toEqual(["rbac.delivery_read"]);
    expect(M2_READ_ONLY_AI_DEFINITIONS.map(({ name }) => name)).not.toContain(
      "delivery.evidence.list",
    );
  });

  it("accepts integer GPS and rejects tenant keys, duplicate attachments and free text", () => {
    expect(DeliveryEvidenceRecordInputSchema.safeParse(pickup).success).toBe(true);
    expect(
      DeliveryEvidenceRecordInputSchema.safeParse({ ...pickup, store_id: STORE }).success,
    ).toBe(false);
    expect(
      DeliveryEvidenceRecordInputSchema.safeParse({
        ...pickup,
        attachment_ids: [PHOTO, PHOTO],
      }).success,
    ).toBe(false);
    expect(
      DeliveryEvidenceRecordInputSchema.safeParse({
        ...pickup,
        event_kind: "exception",
        outcome: "record_only",
        exception_reason: "call customer at 13800000000",
      }).success,
    ).toBe(false);
  });

  it("requires GPS for atomic completion and keeps exceptions record-only", () => {
    expect(DeliveryEvidenceRecordInputSchema.safeParse({ ...pickup, gps: null }).success).toBe(
      false,
    );
    expect(
      DeliveryEvidenceRecordInputSchema.safeParse({
        ...pickup,
        event_kind: "exception",
        exception_reason: "customer_unavailable",
      }).success,
    ).toBe(false);
  });

  it("redacts coordinates and attachment authority from logs and AI results", () => {
    expect(deliveryEvidenceRecordCommand.input_redaction).toEqual(
      expect.arrayContaining([
        { path: "/gps", strategy: "remove" },
        { path: "/attachment_ids", strategy: "remove" },
      ]),
    );
    expect(deliveryEvidenceListQuery.result_redaction).toEqual([
      { path: "/evidence", strategy: "remove" },
    ]);
  });

  it("validates a complete non-secret confirmation authority", () => {
    expect(
      DeliveryEvidenceConfirmationSummarySchema.safeParse({
        kind: "delivery_evidence_record",
        delivery_evidence_id: EVIDENCE,
        delivery_order_id: ORDER,
        delivery_order_version: 3,
        delivery_task_id: TASK,
        delivery_task_version: 2,
        leg: "pickup",
        assignee_staff_id: STAFF,
        event_kind: "pickup",
        outcome: "complete_leg",
        exception_reason: null,
        captured_at: 1_800_000_000,
        has_gps: true,
        photo_count: 1,
        signature_count: 0,
        attachment_set_digest: "a".repeat(64),
      }).success,
    ).toBe(true);
  });
});
