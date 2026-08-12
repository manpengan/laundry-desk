import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

const SYNTHETIC_GARMENT_ID = "99999999-9999-4999-8999-999999999998";
const BATCH_STATUSES = new Set([
  "packing",
  "store_dispatched",
  "factory_received",
  "factory_dispatched",
  "store_received",
  "cancelled",
]);
const GARMENT_STATUSES = new Set([
  "received",
  "washing",
  "ready",
  "racked",
  "picked_up",
  "delivered",
  "reworked",
  "lost",
]);
const CUSTODY_STATES = new Set(["store", "to_factory", "factory", "to_store", "exception"]);
const CHECKPOINTS = new Set([
  "store_dispatch",
  "factory_receive",
  "factory_dispatch",
  "store_receive",
]);
const QUALITY_REASONS = new Set(["stain_remaining", "damage_found", "finish_incomplete", "other"]);
const FORBIDDEN_KEY = /(?:customer|phone|address|recipient|service_note)/iu;
const BARCODE_CONTROL = /[\u0000-\u001f\u007f]/u;

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  requireThat(
    actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index]),
    code,
  );
}

function assertNoCustomerIdentity(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoCustomerIdentity);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    requireThat(!FORBIDDEN_KEY.test(key), "FACTORY_HANDOFF_CUSTOMER_IDENTITY_PRESENT");
    assertNoCustomerIdentity(entry);
  }
}

function readBatch(value) {
  const batch = asRecord(value, "FACTORY_HANDOFF_BATCH_INVALID");
  exactKeys(
    batch,
    [
      "batch_id",
      "exception_count",
      "factory_code",
      "manifest_count",
      "status",
      "updated_at",
      "version",
    ],
    "FACTORY_HANDOFF_BATCH_INVALID",
  );
  const manifestCount = requireInteger(batch.manifest_count, "FACTORY_HANDOFF_BATCH_INVALID");
  const exceptionCount = requireInteger(batch.exception_count, "FACTORY_HANDOFF_BATCH_INVALID");
  requireThat(
    requireUuid(batch.batch_id, "FACTORY_HANDOFF_BATCH_INVALID") === batch.batch_id &&
      /^[A-Z0-9][A-Z0-9_.-]{0,31}$/u.test(
        requireString(batch.factory_code, "FACTORY_HANDOFF_BATCH_INVALID"),
      ) &&
      BATCH_STATUSES.has(batch.status) &&
      requireInteger(batch.version, "FACTORY_HANDOFF_BATCH_INVALID") > 0 &&
      manifestCount >= 0 &&
      manifestCount <= 100 &&
      exceptionCount >= 0 &&
      exceptionCount <= manifestCount &&
      requireInteger(batch.updated_at, "FACTORY_HANDOFF_BATCH_INVALID") >= 0,
    "FACTORY_HANDOFF_BATCH_INVALID",
  );
  return batch;
}

function readEligibleGarment(value) {
  const garment = asRecord(value, "FACTORY_HANDOFF_GARMENT_INVALID");
  exactKeys(
    garment,
    ["barcode", "custody_state", "garment_id", "order_id", "status", "ticket_no"],
    "FACTORY_HANDOFF_GARMENT_INVALID",
  );
  requireUuid(garment.garment_id, "FACTORY_HANDOFF_GARMENT_INVALID");
  requireUuid(garment.order_id, "FACTORY_HANDOFF_GARMENT_INVALID");
  readBarcode(garment.barcode, "FACTORY_HANDOFF_GARMENT_INVALID");
  requireThat(
    requireString(garment.ticket_no, "FACTORY_HANDOFF_GARMENT_INVALID").length <= 64 &&
      GARMENT_STATUSES.has(garment.status) &&
      CUSTODY_STATES.has(garment.custody_state),
    "FACTORY_HANDOFF_GARMENT_INVALID",
  );
  return garment;
}

function readBarcode(value, code) {
  const barcode = requireString(value, code).trim();
  requireThat(
    barcode.length >= 1 &&
      barcode.length <= 64 &&
      !BARCODE_CONTROL.test(barcode) &&
      new TextEncoder().encode(barcode).byteLength <= 64,
    code,
  );
  return barcode;
}

function readBarcodeList(value) {
  requireThat(Array.isArray(value) && value.length <= 100, "FACTORY_HANDOFF_DETAIL_INVALID");
  const barcodes = value.map((barcode) => readBarcode(barcode, "FACTORY_HANDOFF_DETAIL_INVALID"));
  requireThat(
    new Set(barcodes).size === barcodes.length &&
      barcodes.every((barcode, index) => index === 0 || barcodes[index - 1] <= barcode),
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
  return barcodes;
}

function readCheckpoint(value) {
  const checkpoint = asRecord(value, "FACTORY_HANDOFF_DETAIL_INVALID");
  exactKeys(
    checkpoint,
    ["checkpoint", "completed_at", "matched_count", "missing_count", "unexpected_count"],
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
  requireThat(
    CHECKPOINTS.has(checkpoint.checkpoint) &&
      requireInteger(checkpoint.completed_at, "FACTORY_HANDOFF_DETAIL_INVALID") >= 0 &&
      requireInteger(checkpoint.matched_count, "FACTORY_HANDOFF_DETAIL_INVALID") >= 0 &&
      requireInteger(checkpoint.missing_count, "FACTORY_HANDOFF_DETAIL_INVALID") >= 0 &&
      requireInteger(checkpoint.unexpected_count, "FACTORY_HANDOFF_DETAIL_INVALID") >= 0,
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
}

function readAttempt(value) {
  const attempt = asRecord(value, "FACTORY_HANDOFF_DETAIL_INVALID");
  exactKeys(
    attempt,
    [
      "attempt_id",
      "checkpoint",
      "matched_barcodes",
      "missing_barcodes",
      "outcome",
      "recorded_at",
      "unexpected_barcodes",
    ],
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
  requireUuid(attempt.attempt_id, "FACTORY_HANDOFF_DETAIL_INVALID");
  const barcodeSets = [
    readBarcodeList(attempt.matched_barcodes),
    readBarcodeList(attempt.missing_barcodes),
    readBarcodeList(attempt.unexpected_barcodes),
  ];
  const allBarcodes = barcodeSets.flat();
  const hasDifference = barcodeSets[1].length + barcodeSets[2].length > 0;
  requireThat(
    CHECKPOINTS.has(attempt.checkpoint) &&
      ["matched", "discrepancy"].includes(attempt.outcome) &&
      (attempt.outcome === "discrepancy") === hasDifference &&
      new Set(allBarcodes).size === allBarcodes.length &&
      requireInteger(attempt.recorded_at, "FACTORY_HANDOFF_DETAIL_INVALID") >= 0,
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
}

function readQualityCheck(value) {
  const qualityCheck = asRecord(value, "FACTORY_HANDOFF_DETAIL_INVALID");
  exactKeys(
    qualityCheck,
    ["garment_id", "inspected_at", "outcome", "reason_code"],
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
  requireUuid(qualityCheck.garment_id, "FACTORY_HANDOFF_DETAIL_INVALID");
  const isRework = qualityCheck.outcome === "rework";
  requireThat(
    ["pass", "rework"].includes(qualityCheck.outcome) &&
      (qualityCheck.reason_code === null || QUALITY_REASONS.has(qualityCheck.reason_code)) &&
      isRework === (qualityCheck.reason_code !== null) &&
      requireInteger(qualityCheck.inspected_at, "FACTORY_HANDOFF_DETAIL_INVALID") >= 0,
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
}

function readDetail(value, batchId) {
  const detail = asRecord(value, "FACTORY_HANDOFF_DETAIL_INVALID");
  exactKeys(
    detail,
    ["batch", "checkpoints", "latest_attempt", "manifest", "quality_checks"],
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
  requireThat(readBatch(detail.batch).batch_id === batchId, "FACTORY_HANDOFF_DETAIL_INVALID");
  requireThat(
    Array.isArray(detail.manifest) &&
      detail.manifest.length <= 100 &&
      Array.isArray(detail.checkpoints) &&
      detail.checkpoints.length <= 4 &&
      Array.isArray(detail.quality_checks) &&
      detail.quality_checks.length <= 100,
    "FACTORY_HANDOFF_DETAIL_INVALID",
  );
  for (const value_ of detail.manifest) {
    const garment = asRecord(value_, "FACTORY_HANDOFF_DETAIL_INVALID");
    exactKeys(
      garment,
      [
        "barcode",
        "custody_state",
        "garment_id",
        "member_state",
        "order_id",
        "qc_status",
        "status",
        "ticket_no",
      ],
      "FACTORY_HANDOFF_DETAIL_INVALID",
    );
    readEligibleGarment({
      barcode: garment.barcode,
      custody_state: garment.custody_state,
      garment_id: garment.garment_id,
      order_id: garment.order_id,
      status: garment.status,
      ticket_no: garment.ticket_no,
    });
    requireThat(
      ["active", "exception", "completed"].includes(garment.member_state) &&
        ["pending", "pass", "rework"].includes(garment.qc_status),
      "FACTORY_HANDOFF_DETAIL_INVALID",
    );
  }
  detail.checkpoints.forEach(readCheckpoint);
  if (detail.latest_attempt !== null) readAttempt(detail.latest_attempt);
  detail.quality_checks.forEach(readQualityCheck);
  assertNoCustomerIdentity(detail);
  return detail;
}

export async function factoryHandoffBoundaryJourney(api, context) {
  requireThat(typeof api?.query === "function", "FACTORY_HANDOFF_API_INVALID");
  requireThat(typeof api?.expectCommandFailure === "function", "FACTORY_HANDOFF_API_INVALID");
  const session = asRecord(context?.session, "FACTORY_HANDOFF_CONTEXT_INVALID");
  await api.expectCommandFailure(
    session,
    "fulfillment.batch.create",
    {
      factory_code: "FACTORY_UAT",
      garment_ids: [SYNTHETIC_GARMENT_ID],
      customer_phone: "19900000000",
    },
    "VALIDATION_FAILED",
  );
  const listed = asRecord(
    await api.query(session, "fulfillment.batches.list", { limit: 5 }),
    "FACTORY_HANDOFF_LIST_INVALID",
  );
  exactKeys(listed, ["batches", "eligible_garments"], "FACTORY_HANDOFF_LIST_INVALID");
  requireThat(
    Array.isArray(listed.batches) &&
      listed.batches.length <= 5 &&
      Array.isArray(listed.eligible_garments) &&
      listed.eligible_garments.length <= 100,
    "FACTORY_HANDOFF_LIST_INVALID",
  );
  assertNoCustomerIdentity(listed);
  const batches = listed.batches.map(readBatch);
  listed.eligible_garments.forEach(readEligibleGarment);
  for (const batch of batches) {
    readDetail(
      await api.query(session, "fulfillment.batch.get", { batch_id: batch.batch_id }),
      batch.batch_id,
    );
  }
  return Object.freeze({
    observedBatches: batches.length,
    observedEligible: listed.eligible_garments.length,
  });
}
