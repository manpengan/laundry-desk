import type { DeliveryEvidence } from "@laundry/contracts";

import { freezeEvidence, publicAttachment, type StoredDeliveryAttachment } from "./types.js";

export type DeliveryAttachmentRow = Readonly<{
  attachment_id: string;
  org_id: string;
  store_id: string;
  delivery_order_id: string;
  delivery_task_id: string;
  leg: "pickup" | "return";
  delivery_task_version: number;
  assignee_staff_id: string;
  kind: "photo" | "signature";
  storage_key: string;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  content_sha256: string;
  byte_size: number;
  captured_at: Date | string;
  expires_at: Date | string;
  created_at: Date | string;
  created_by_staff_id: string;
}>;

export type DeliveryEvidenceRow = Readonly<{
  delivery_evidence_id: string;
  delivery_order_id: string;
  delivery_task_id: string;
  leg: "pickup" | "return";
  delivery_task_version: number;
  assignee_staff_id: string;
  event_kind: "pickup" | "delivered" | "exception";
  outcome: "record_only" | "complete_leg";
  exception_reason: DeliveryEvidence["exception_reason"];
  captured_at: Date | string;
  latitude_e7: number | null;
  longitude_e7: number | null;
  accuracy_mm: number | null;
  gps_captured_at: Date | string | null;
  recorded_at: Date | string;
}>;

export const DELIVERY_ATTACHMENT_COLUMNS = `id::text AS attachment_id, org_id::text, store_id::text,
       delivery_order_id::text, delivery_task_id::text, leg, delivery_task_version,
       assignee_staff_id::text, kind, storage_key, content_type,
       content_sha256::text, byte_size, captured_at, expires_at, created_at,
       created_by_staff_id::text`;
export const DELIVERY_ATTACHMENT_JOIN_COLUMNS = `attachment.id::text AS attachment_id,
       attachment.org_id::text, attachment.store_id::text, attachment.delivery_order_id::text,
       attachment.delivery_task_id::text, attachment.leg, attachment.delivery_task_version,
       attachment.assignee_staff_id::text, attachment.kind, attachment.storage_key,
       attachment.content_type, attachment.content_sha256::text, attachment.byte_size,
       attachment.captured_at, attachment.expires_at, attachment.created_at,
       attachment.created_by_staff_id::text`;
export const DELIVERY_EVIDENCE_COLUMNS = `id::text AS delivery_evidence_id, delivery_order_id::text,
       delivery_task_id::text, leg, delivery_task_version, assignee_staff_id::text,
       event_kind, outcome, exception_reason, captured_at, latitude_e7, longitude_e7,
       accuracy_mm, gps_captured_at, recorded_at`;

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);

export function mapDeliveryAttachment(row: DeliveryAttachmentRow): StoredDeliveryAttachment {
  return Object.freeze({
    ...row,
    captured_at: epoch(row.captured_at),
    expires_at: epoch(row.expires_at),
    created_at: epoch(row.created_at),
  });
}

export function mapDeliveryEvidence(
  row: DeliveryEvidenceRow,
  attachments: readonly StoredDeliveryAttachment[],
) {
  return freezeEvidence({
    delivery_evidence_id: row.delivery_evidence_id,
    delivery_order_id: row.delivery_order_id,
    delivery_task_id: row.delivery_task_id,
    leg: row.leg,
    delivery_task_version: row.delivery_task_version,
    assignee_staff_id: row.assignee_staff_id,
    event_kind: row.event_kind,
    outcome: row.outcome,
    exception_reason: row.exception_reason,
    captured_at: epoch(row.captured_at),
    gps:
      row.latitude_e7 === null ||
      row.longitude_e7 === null ||
      row.accuracy_mm === null ||
      row.gps_captured_at === null
        ? null
        : Object.freeze({
            latitude_e7: row.latitude_e7,
            longitude_e7: row.longitude_e7,
            accuracy_mm: row.accuracy_mm,
            captured_at: epoch(row.gps_captured_at),
          }),
    attachments: attachments.map(publicAttachment),
    recorded_at: epoch(row.recorded_at),
  });
}
