import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryEvidenceAttachment, DeliveryOrder, DeliveryTask } from "@laundry/contracts";

import {
  buildDeliveryEvidenceRecord,
  evidenceSummaryMatches,
  parseDeliveryEvidenceList,
} from "./mobile-delivery-evidence-model.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";
const PHOTO_ID = "55555555-5555-4555-8555-555555555555";
const SIGNATURE_ID = "66666666-6666-4666-8666-666666666666";
const NOW = 1_800_000_000;

const order: DeliveryOrder = Object.freeze({
  delivery_order_id: ORDER_ID,
  laundry_order_id: "77777777-7777-4777-8777-777777777777",
  customer_id: "88888888-8888-4888-8888-888888888888",
  collection_method: "store_dropoff",
  return_method: "delivery",
  pickup_appointment_id: null,
  return_appointment_id: "99999999-9999-4999-8999-999999999999",
  pickup_fee_cents: 0,
  return_fee_cents: 900,
  total_fee_cents: 900,
  status: "return_in_progress",
  version: 6,
  created_at: NOW - 100,
  updated_at: NOW - 10,
  completed_at: null,
  cancelled_at: null,
  cancellation_reason: null,
});

const task: DeliveryTask = Object.freeze({
  delivery_task_id: TASK_ID,
  delivery_order_id: ORDER_ID,
  leg: "return",
  assignee_staff_id: STAFF_ID,
  assigned_by_staff_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  predecessor_task_id: null,
  source: "assignment",
  status: "accepted",
  version: 2,
  created_at: NOW - 50,
  updated_at: NOW - 20,
  accepted_at: NOW - 20,
  rejected_at: null,
  transferred_at: null,
  taken_over_at: null,
  completed_at: null,
  cancelled_at: null,
  resolution_reason: null,
});

const attachment = (attachment_id: string, kind: "photo" | "signature") =>
  Object.freeze({
    attachment_id,
    kind,
    content_type: "image/jpeg" as const,
    byte_size: 256,
    captured_at: NOW - 1,
  }) satisfies DeliveryEvidenceAttachment;

const gps = Object.freeze({
  latitude_e7: 251_234_567,
  longitude_e7: 1_215_678_901,
  accuracy_mm: 3_000,
  captured_at: NOW - 1,
});

test("return completion requires explicit GPS, photo and signature before submission", () => {
  const detail = Object.freeze({ task, order });
  const base = Object.freeze({
    detail,
    evidenceId: EVIDENCE_ID,
    mode: "complete" as const,
    reason: "customer_unavailable" as const,
    capturedAt: NOW,
    gps,
  });
  assert.equal(
    buildDeliveryEvidenceRecord({ ...base, attachments: [attachment(PHOTO_ID, "photo")] }),
    null,
  );
  const body = buildDeliveryEvidenceRecord({
    ...base,
    attachments: [attachment(PHOTO_ID, "photo"), attachment(SIGNATURE_ID, "signature")],
  });
  assert.notEqual(body, null);
  assert.deepEqual(body?.attachment_ids, [PHOTO_ID, SIGNATURE_ID]);
});

test("confirmation matching covers exact non-secret authority and attachment digest", async () => {
  const attachments = [attachment(PHOTO_ID, "photo"), attachment(SIGNATURE_ID, "signature")];
  const body = buildDeliveryEvidenceRecord({
    detail: Object.freeze({ task, order }),
    evidenceId: EVIDENCE_ID,
    mode: "complete",
    reason: "customer_unavailable",
    capturedAt: NOW,
    gps,
    attachments,
  });
  assert.notEqual(body, null);
  if (body === null) return;
  const digestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([...body.attachment_ids].sort().join("\n")),
  );
  const digest = [...new Uint8Array(digestBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const summary = Object.freeze({
    kind: "delivery_evidence_record" as const,
    delivery_evidence_id: EVIDENCE_ID,
    delivery_order_id: ORDER_ID,
    delivery_order_version: 6,
    delivery_task_id: TASK_ID,
    delivery_task_version: 2,
    leg: "return" as const,
    assignee_staff_id: STAFF_ID,
    event_kind: "delivered" as const,
    outcome: "complete_leg" as const,
    exception_reason: null,
    captured_at: NOW,
    has_gps: true,
    photo_count: 1,
    signature_count: 1,
    attachment_set_digest: digest,
  });
  assert.equal(await evidenceSummaryMatches(summary, body, STAFF_ID, attachments), true);
  assert.equal(
    await evidenceSummaryMatches(
      { ...summary, delivery_task_version: 3 },
      body,
      STAFF_ID,
      attachments,
    ),
    false,
  );
});

test("list parsing is strict and rejects hidden storage authority", () => {
  const evidence = Object.freeze({
    delivery_evidence_id: EVIDENCE_ID,
    delivery_order_id: ORDER_ID,
    delivery_task_id: TASK_ID,
    leg: "return" as const,
    delivery_task_version: 2,
    assignee_staff_id: STAFF_ID,
    event_kind: "exception" as const,
    outcome: "record_only" as const,
    exception_reason: "customer_unavailable" as const,
    captured_at: NOW,
    gps: null,
    attachments: [attachment(PHOTO_ID, "photo")],
    recorded_at: NOW,
  });
  assert.deepEqual(parseDeliveryEvidenceList({ result: { evidence: [evidence] } }), [evidence]);
  assert.equal(
    parseDeliveryEvidenceList({
      result: { evidence: [{ ...evidence, storage_key: "private/delivery.jpg" }] },
    }),
    null,
  );
});
