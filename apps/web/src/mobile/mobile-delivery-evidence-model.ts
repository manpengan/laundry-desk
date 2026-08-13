import {
  DeliveryEvidenceListResultSchema,
  DeliveryEvidenceRecordInputSchema,
  DeliveryEvidenceRecordResultSchema,
  type DeliveryEvidence,
  type DeliveryEvidenceAttachment,
  type DeliveryEvidenceConfirmationSummary,
  type DeliveryEvidenceExceptionReason,
  type DeliveryEvidenceRecordInput,
} from "@laundry/contracts";

import type { MobileTaskDetail } from "./mobile-task-model.js";

export const DELIVERY_EVIDENCE_REASON_LABELS: Readonly<
  Record<DeliveryEvidenceExceptionReason, string>
> = Object.freeze({
  customer_unavailable: "顾客无法联系",
  access_blocked: "无法进入交付地点",
  item_mismatch: "衣物数量或标识不符",
  unsafe_location: "现场环境不安全",
  weather: "天气原因",
  vehicle_issue: "车辆故障",
  other: "其他受控原因",
});

function unwrapResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return "result" in record ? record.result : value;
}

const freezeEvidence = (row: DeliveryEvidence): DeliveryEvidence =>
  Object.freeze({
    ...row,
    gps: row.gps === null ? null : Object.freeze({ ...row.gps }),
    attachments: row.attachments.map((attachment) => Object.freeze({ ...attachment })),
  });

export function parseDeliveryEvidenceList(value: unknown): readonly DeliveryEvidence[] | null {
  const parsed = DeliveryEvidenceListResultSchema.safeParse(unwrapResult(value));
  return parsed.success ? Object.freeze(parsed.data.evidence.map(freezeEvidence)) : null;
}

export function parseDeliveryEvidenceRecord(value: unknown) {
  const parsed = DeliveryEvidenceRecordResultSchema.safeParse(unwrapResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    evidence: freezeEvidence(parsed.data.evidence),
    delivery_order: Object.freeze({ ...parsed.data.delivery_order }),
    delivery_task: Object.freeze({ ...parsed.data.delivery_task }),
  });
}

export function deliveryEvidenceCanComplete(detail: MobileTaskDetail | null): boolean {
  if (detail?.task.status !== "accepted") return false;
  return detail.task.leg === "pickup"
    ? detail.order.status === "pickup_in_progress"
    : detail.order.status === "return_in_progress";
}

export function buildDeliveryEvidenceRecord(
  input: Readonly<{
    detail: MobileTaskDetail;
    evidenceId: string;
    mode: "complete" | "exception";
    reason: DeliveryEvidenceExceptionReason;
    capturedAt: number;
    gps: DeliveryEvidenceRecordInput["gps"];
    attachments: readonly DeliveryEvidenceAttachment[];
  }>,
): DeliveryEvidenceRecordInput | null {
  const attachmentKinds = new Set(input.attachments.map(({ kind }) => kind));
  if (
    input.mode === "complete" &&
    (!attachmentKinds.has("photo") ||
      (input.detail.task.leg === "return" && !attachmentKinds.has("signature")))
  ) {
    return null;
  }
  const parsed = DeliveryEvidenceRecordInputSchema.safeParse({
    delivery_evidence_id: input.evidenceId,
    delivery_order_id: input.detail.order.delivery_order_id,
    delivery_task_id: input.detail.task.delivery_task_id,
    leg: input.detail.task.leg,
    expected_delivery_order_version: input.detail.order.version,
    expected_delivery_task_version: input.detail.task.version,
    event_kind:
      input.mode === "exception"
        ? "exception"
        : input.detail.task.leg === "pickup"
          ? "pickup"
          : "delivered",
    outcome: input.mode === "complete" ? "complete_leg" : "record_only",
    ...(input.mode === "exception" ? { exception_reason: input.reason } : {}),
    captured_at: input.capturedAt,
    gps: input.gps,
    attachment_ids: input.attachments.map(({ attachment_id }) => attachment_id),
  });
  if (!parsed.success) return null;
  return Object.freeze({
    ...parsed.data,
    gps: parsed.data.gps === null ? null : Object.freeze({ ...parsed.data.gps }),
    attachment_ids: [...parsed.data.attachment_ids],
  });
}

export async function attachmentSetDigest(ids: readonly string[]): Promise<string> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new Error("Secure digest is unavailable");
  }
  const encoded = new TextEncoder().encode([...ids].sort().join("\n"));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evidenceSummaryMatches(
  summary: DeliveryEvidenceConfirmationSummary,
  body: DeliveryEvidenceRecordInput,
  currentStaffId: string,
  attachments: readonly DeliveryEvidenceAttachment[],
): Promise<boolean> {
  const photoCount = attachments.filter(({ kind }) => kind === "photo").length;
  const signatureCount = attachments.filter(({ kind }) => kind === "signature").length;
  return (
    summary.delivery_evidence_id === body.delivery_evidence_id &&
    summary.delivery_order_id === body.delivery_order_id &&
    summary.delivery_order_version === body.expected_delivery_order_version &&
    summary.delivery_task_id === body.delivery_task_id &&
    summary.delivery_task_version === body.expected_delivery_task_version &&
    summary.leg === body.leg &&
    summary.assignee_staff_id === currentStaffId &&
    summary.event_kind === body.event_kind &&
    summary.outcome === body.outcome &&
    summary.exception_reason === (body.exception_reason ?? null) &&
    summary.captured_at === body.captured_at &&
    summary.has_gps === (body.gps !== null) &&
    summary.photo_count === photoCount &&
    summary.signature_count === signatureCount &&
    summary.attachment_set_digest === (await attachmentSetDigest(body.attachment_ids))
  );
}
