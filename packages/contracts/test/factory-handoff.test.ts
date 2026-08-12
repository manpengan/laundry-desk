import { describe, expect, it } from "vitest";

import {
  FACTORY_HANDOFF_COMMANDS,
  FACTORY_HANDOFF_QUERIES,
  FactoryHandoffConfirmationSummarySchema,
  FactoryHandoffBarcodeSchema,
  FulfillmentOperationConfirmationSummarySchema,
  createCommandError,
  factoryHandoffCheckpointRecordCommand,
  factoryHandoffDiscrepancyResolveCommand,
  factoryQualityCheckRecordCommand,
  parseContractInput,
} from "../src/index.js";

const GARMENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_GARMENT_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST = "a".repeat(64);

describe("ADR-45 factory handoff contracts", () => {
  it("freezes five online commands and two non-AI queries", () => {
    expect(FACTORY_HANDOFF_COMMANDS.map(({ name }) => name)).toEqual([
      "fulfillment.batch.create",
      "fulfillment.batch.cancel",
      "fulfillment.handoff.checkpoint.record",
      "fulfillment.handoff.discrepancy.resolve",
      "fulfillment.quality_check.record",
    ]);
    expect(FACTORY_HANDOFF_QUERIES.map(({ name }) => name)).toEqual([
      "fulfillment.batches.list",
      "fulfillment.batch.get",
    ]);
    expect(FACTORY_HANDOFF_COMMANDS.every(({ offline_mode }) => offline_mode === "denied")).toBe(
      true,
    );
    expect(factoryHandoffCheckpointRecordCommand.risk_escalation).toEqual({ max_batch: 50 });
    expect(factoryHandoffDiscrepancyResolveCommand.risk).toBe("R4");
  });

  it("rejects duplicate checkpoint manifests and client-authored mismatched QC sets", async () => {
    await expect(
      parseContractInput(factoryHandoffCheckpointRecordCommand, {
        batch_id: BATCH_ID,
        checkpoint: "store_dispatch",
        expected_version: 1,
        garment_ids: [GARMENT_ID, GARMENT_ID],
        scanned_barcodes: ["G-001", "G-002"],
      }),
    ).rejects.toBeTruthy();

    await expect(
      parseContractInput(factoryQualityCheckRecordCommand, {
        batch_id: BATCH_ID,
        expected_version: 4,
        garment_ids: [GARMENT_ID, SECOND_GARMENT_ID],
        checks: [{ garment_id: GARMENT_ID, outcome: "pass", reason_code: null }],
      }),
    ).rejects.toBeTruthy();
  });

  it("aligns scanned barcode length with the PostgreSQL UTF-8 byte boundary", () => {
    expect(FactoryHandoffBarcodeSchema.safeParse("A".repeat(64)).success).toBe(true);
    expect(FactoryHandoffBarcodeSchema.safeParse("衣".repeat(22)).success).toBe(false);
    expect(FactoryHandoffBarcodeSchema.safeParse("G-001\nFORGED").success).toBe(false);
  });

  it("requires a controlled reason for every rework QC row", async () => {
    await expect(
      parseContractInput(factoryQualityCheckRecordCommand, {
        batch_id: BATCH_ID,
        expected_version: 4,
        garment_ids: [GARMENT_ID],
        checks: [{ garment_id: GARMENT_ID, outcome: "rework", reason_code: null }],
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(factoryQualityCheckRecordCommand, {
        batch_id: BATCH_ID,
        expected_version: 4,
        garment_ids: [GARMENT_ID],
        checks: [{ garment_id: GARMENT_ID, outcome: "rework", reason_code: "stain_remaining" }],
      }),
    ).resolves.toBeTruthy();
  });

  it("accepts only sorted, internally consistent privacy-safe handoff summaries", () => {
    const valid = {
      kind: "factory_handoff",
      operation: "checkpoint_record",
      batch_id: BATCH_ID,
      expected_version: 1,
      checkpoint: "store_dispatch",
      factory_code: "FACTORY_01",
      ticket_nos: ["T-001", "T-001"],
      barcodes: ["G-001", "G-002"],
      counts: {
        manifest_count: 2,
        scan_count: 2,
        matched_count: 2,
        missing_count: 0,
        unexpected_count: 0,
        pass_count: 0,
        rework_count: 0,
      },
      manifest_digest: DIGEST,
    } as const;
    expect(FactoryHandoffConfirmationSummarySchema.parse(valid)).toEqual(valid);
    expect(
      FactoryHandoffConfirmationSummarySchema.safeParse({
        ...valid,
        barcodes: ["G-002", "G-001"],
      }).success,
    ).toBe(false);

    const error = createCommandError("POLICY_CONFIRMATION_REQUIRED", {
      kind: "confirmation",
      confirm_ref: ATTEMPT_ID,
      summary: valid,
    });
    if (error.detail?.kind === "confirmation" && error.detail.summary?.kind === "factory_handoff") {
      expect(Object.isFrozen(error.detail.summary)).toBe(true);
      expect(Object.isFrozen(error.detail.summary.ticket_nos)).toBe(true);
      expect(Object.isFrozen(error.detail.summary.barcodes)).toBe(true);
      expect(Object.isFrozen(error.detail.summary.counts)).toBe(true);
    } else {
      throw new Error("Expected a factory handoff confirmation summary");
    }
  });

  it("freezes existing R3/R4 fulfillment facts without customer identity", () => {
    const valid = {
      kind: "fulfillment_operation",
      operation: "incident_record",
      garment_ids: [GARMENT_ID],
      ticket_nos: ["T-001"],
      barcodes: ["G-001"],
      target_status: null,
      incident_kind: "damage",
      compensation_cents: 1200,
      reason: null,
      note: "纽扣破损",
      manifest_digest: DIGEST,
    } as const;
    expect(FulfillmentOperationConfirmationSummarySchema.parse(valid)).toEqual(valid);
    expect(JSON.stringify(valid)).not.toMatch(/customer|phone/iu);

    const error = createCommandError("POLICY_STEP_UP_REQUIRED", {
      kind: "confirmation",
      confirm_ref: ATTEMPT_ID,
      summary: valid,
    });
    if (
      error.detail?.kind === "confirmation" &&
      error.detail.summary?.kind === "fulfillment_operation"
    ) {
      expect(Object.isFrozen(error.detail.summary.garment_ids)).toBe(true);
      expect(Object.isFrozen(error.detail.summary.ticket_nos)).toBe(true);
      expect(Object.isFrozen(error.detail.summary.barcodes)).toBe(true);
    } else {
      throw new Error("Expected a fulfillment operation confirmation summary");
    }
  });

  it("preserves the existing optional empty batch-transition note boundary", () => {
    expect(
      FulfillmentOperationConfirmationSummarySchema.safeParse({
        kind: "fulfillment_operation",
        operation: "bulk_transition",
        garment_ids: [GARMENT_ID, SECOND_GARMENT_ID],
        ticket_nos: ["T-001", "T-002"],
        barcodes: ["G-001", "G-002"],
        target_status: "ready",
        incident_kind: null,
        compensation_cents: null,
        reason: null,
        note: "",
        manifest_digest: DIGEST,
      }).success,
    ).toBe(true);
  });

  it("accepts a bounded R4 discrepancy correction", async () => {
    await expect(
      parseContractInput(factoryHandoffDiscrepancyResolveCommand, {
        batch_id: BATCH_ID,
        attempt_id: ATTEMPT_ID,
        expected_version: 2,
        garment_ids: [GARMENT_ID],
        reason_code: "recount_verified",
      }),
    ).resolves.toBeTruthy();
    await expect(
      parseContractInput(factoryHandoffDiscrepancyResolveCommand, {
        batch_id: BATCH_ID,
        attempt_id: ATTEMPT_ID,
        expected_version: 2,
        garment_ids: [],
        reason_code: "exception_accepted",
      }),
    ).resolves.toBeTruthy();
  });
});
