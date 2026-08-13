import { createHash } from "node:crypto";

import {
  DeliveryEvidenceAttachmentSchema,
  DeliveryEvidenceConfirmationSummarySchema,
  DeliveryEvidenceSchema,
  type DeliveryEvidence,
  type DeliveryEvidenceAttachment,
  type DeliveryEvidenceAttachmentKind,
  type DeliveryEvidenceConfirmationSummary,
  type DeliveryEvidenceRecordInput,
  type DeliveryOrder,
  type DeliveryTask,
} from "@laundry/contracts";

type RequestScope = Readonly<{ org_id: string; store_id: string; staff_id: string }>;

export type DeliveryEvidencePrepareRequest = RequestScope &
  DeliveryEvidenceRecordInput &
  Readonly<{ at: number }>;

export type DeliveryEvidenceRecordRequest = DeliveryEvidencePrepareRequest &
  Readonly<{ authority: DeliveryEvidenceConfirmationSummary }>;

export type DeliveryAttachmentRegisterRequest = RequestScope &
  Readonly<{
    attachment_id: string;
    delivery_order_id: string;
    delivery_task_id: string;
    leg: "pickup" | "return";
    expected_delivery_task_version: number;
    kind: DeliveryEvidenceAttachmentKind;
    storage_key: string;
    content_type: DeliveryEvidenceAttachment["content_type"];
    content_sha256: string;
    byte_size: number;
    captured_at: number;
    at: number;
  }>;

export type StoredDeliveryAttachment = DeliveryEvidenceAttachment &
  Readonly<{
    org_id: string;
    store_id: string;
    delivery_order_id: string;
    delivery_task_id: string;
    leg: "pickup" | "return";
    delivery_task_version: number;
    assignee_staff_id: string;
    storage_key: string;
    content_sha256: string;
    expires_at: number;
    created_at: number;
    created_by_staff_id: string;
  }>;

export type DeliveryAttachmentRegisterResult =
  | Readonly<{ ok: true; attachment: StoredDeliveryAttachment; replay: boolean }>
  | Readonly<{ ok: false; reason: "authority" | "conflict" }>;

export type DeliveryEvidenceRecordResult =
  | Readonly<{
      ok: true;
      evidence: DeliveryEvidence;
      delivery_order: DeliveryOrder;
      delivery_task: DeliveryTask;
    }>
  | Readonly<{ ok: false; reason: "authority" | "conflict" | "duplicate" }>;

export type DeliveryEvidenceStore = Readonly<{
  prepare: (
    request: DeliveryEvidencePrepareRequest,
  ) => Promise<DeliveryEvidenceConfirmationSummary | null>;
  record: (request: DeliveryEvidenceRecordRequest) => Promise<DeliveryEvidenceRecordResult>;
  list: (
    orgId: string,
    storeId: string,
    staffId: string,
    deliveryTaskId: string,
    limit: number,
  ) => Promise<readonly DeliveryEvidence[]>;
  registerAttachment: (
    request: DeliveryAttachmentRegisterRequest,
  ) => Promise<DeliveryAttachmentRegisterResult>;
  authorizedAttachment: (
    orgId: string,
    storeId: string,
    staffId: string,
    attachmentId: string,
  ) => Promise<StoredDeliveryAttachment | null>;
  uploadedAttachment: (
    orgId: string,
    storeId: string,
    staffId: string,
    attachmentId: string,
  ) => Promise<StoredDeliveryAttachment | null>;
  referencedStorageKeys: (orgId: string, storeId: string) => Promise<ReadonlySet<string>>;
}>;

export function attachmentSetDigest(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join("\n"), "utf8")
    .digest("hex");
}

export function publicAttachment(row: StoredDeliveryAttachment): DeliveryEvidenceAttachment {
  return Object.freeze(
    DeliveryEvidenceAttachmentSchema.parse({
      attachment_id: row.attachment_id,
      kind: row.kind,
      content_type: row.content_type,
      byte_size: row.byte_size,
      captured_at: row.captured_at,
    }),
  );
}

export function freezeEvidence(input: DeliveryEvidence): DeliveryEvidence {
  const row = DeliveryEvidenceSchema.parse(input);
  return Object.freeze({
    ...row,
    gps: row.gps === null ? null : Object.freeze({ ...row.gps }),
    attachments: row.attachments.map((attachment) => Object.freeze({ ...attachment })),
  });
}

export function freezeEvidenceConfirmation(
  input: DeliveryEvidenceConfirmationSummary,
): DeliveryEvidenceConfirmationSummary {
  return Object.freeze(DeliveryEvidenceConfirmationSummarySchema.parse(input));
}

export function sameEvidenceAuthority(
  left: DeliveryEvidenceConfirmationSummary,
  right: DeliveryEvidenceConfirmationSummary,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
