import {
  deliveryEvidenceCompletionTarget,
  deliveryEvidenceOrderStatusAllowsCompletion,
  deliveryEvidenceOrderStatusAllowsRecord,
  hasRequiredDeliveryEvidence,
} from "@laundry/domain";

import type { DeliveryOrderStore } from "../delivery-orders/types.js";
import type { DeliveryTaskStore } from "../delivery-tasks/types.js";
import {
  attachmentSetDigest,
  freezeEvidence,
  freezeEvidenceConfirmation,
  publicAttachment,
  sameEvidenceAuthority,
  type DeliveryAttachmentRegisterRequest,
  type DeliveryEvidencePrepareRequest,
  type DeliveryEvidenceStore,
  type StoredDeliveryAttachment,
} from "./types.js";

type EvidenceRow = Readonly<{
  org_id: string;
  store_id: string;
  evidence: ReturnType<typeof freezeEvidence>;
}>;

const scopedKey = (orgId: string, storeId: string, id: string): string =>
  `${orgId}|${storeId}|${id}`;

function attachmentFromRequest(
  request: DeliveryAttachmentRegisterRequest,
): StoredDeliveryAttachment {
  return Object.freeze({
    attachment_id: request.attachment_id,
    org_id: request.org_id,
    store_id: request.store_id,
    delivery_order_id: request.delivery_order_id,
    delivery_task_id: request.delivery_task_id,
    leg: request.leg,
    delivery_task_version: request.expected_delivery_task_version,
    assignee_staff_id: request.staff_id,
    kind: request.kind,
    storage_key: request.storage_key,
    content_type: request.content_type,
    content_sha256: request.content_sha256,
    byte_size: request.byte_size,
    captured_at: request.captured_at,
    expires_at: request.at + 86_400,
    created_at: request.at,
    created_by_staff_id: request.staff_id,
  });
}

function attachmentReplayMatches(
  row: StoredDeliveryAttachment,
  request: DeliveryAttachmentRegisterRequest,
): boolean {
  return (
    row.delivery_order_id === request.delivery_order_id &&
    row.delivery_task_id === request.delivery_task_id &&
    row.leg === request.leg &&
    row.delivery_task_version === request.expected_delivery_task_version &&
    row.kind === request.kind &&
    row.content_sha256 === request.content_sha256 &&
    row.byte_size === request.byte_size &&
    row.captured_at === request.captured_at &&
    row.created_by_staff_id === request.staff_id
  );
}

export function createMemoryDeliveryEvidenceStore(
  orders: DeliveryOrderStore,
  tasks: DeliveryTaskStore,
): DeliveryEvidenceStore {
  const attachments = new Map<string, StoredDeliveryAttachment>();
  const evidenceRows = new Map<string, EvidenceRow>();

  const authority = async (request: DeliveryEvidencePrepareRequest) => {
    const [order, task] = await Promise.all([
      orders.get(request.org_id, request.store_id, request.delivery_order_id),
      tasks.get(request.org_id, request.store_id, request.delivery_task_id),
    ]);
    if (
      order === null ||
      task === null ||
      order.version !== request.expected_delivery_order_version ||
      task.delivery_order_id !== order.delivery_order_id ||
      task.leg !== request.leg ||
      task.version !== request.expected_delivery_task_version ||
      task.status !== "accepted" ||
      task.assignee_staff_id !== request.staff_id ||
      !deliveryEvidenceOrderStatusAllowsRecord(request.leg, order.status) ||
      (request.outcome === "complete_leg" &&
        !deliveryEvidenceOrderStatusAllowsCompletion(request.leg, order.status))
    ) {
      return null;
    }
    const selected = request.attachment_ids.map((id) =>
      attachments.get(scopedKey(request.org_id, request.store_id, id)),
    );
    if (
      selected.some(
        (row) =>
          row === undefined ||
          row.delivery_order_id !== order.delivery_order_id ||
          row.delivery_task_id !== task.delivery_task_id ||
          row.delivery_task_version !== task.version ||
          row.leg !== task.leg ||
          row.created_by_staff_id !== request.staff_id ||
          row.expires_at < request.at,
      )
    ) {
      return null;
    }
    const rows = selected as readonly StoredDeliveryAttachment[];
    if (
      !hasRequiredDeliveryEvidence({
        leg: request.leg,
        outcome: request.outcome,
        eventKind: request.event_kind,
        taskStatus: task.status,
        hasGps: request.gps !== null,
        attachmentKinds: rows.map(({ kind }) => kind),
      })
    ) {
      return null;
    }
    return freezeEvidenceConfirmation({
      kind: "delivery_evidence_record",
      delivery_evidence_id: request.delivery_evidence_id,
      delivery_order_id: order.delivery_order_id,
      delivery_order_version: order.version,
      delivery_task_id: task.delivery_task_id,
      delivery_task_version: task.version,
      leg: task.leg,
      assignee_staff_id: task.assignee_staff_id,
      event_kind: request.event_kind,
      outcome: request.outcome,
      exception_reason: request.exception_reason ?? null,
      captured_at: request.captured_at,
      has_gps: request.gps !== null,
      photo_count: rows.filter(({ kind }) => kind === "photo").length,
      signature_count: rows.filter(({ kind }) => kind === "signature").length,
      attachment_set_digest: attachmentSetDigest(request.attachment_ids),
    });
  };

  return Object.freeze({
    prepare: authority,
    async registerAttachment(request) {
      const existing = attachments.get(
        scopedKey(request.org_id, request.store_id, request.attachment_id),
      );
      if (existing !== undefined) {
        return attachmentReplayMatches(existing, request)
          ? Object.freeze({ ok: true, attachment: existing, replay: true })
          : Object.freeze({ ok: false, reason: "conflict" });
      }
      const [order, task] = await Promise.all([
        orders.get(request.org_id, request.store_id, request.delivery_order_id),
        tasks.get(request.org_id, request.store_id, request.delivery_task_id),
      ]);
      if (
        order === null ||
        task === null ||
        task.delivery_order_id !== order.delivery_order_id ||
        task.leg !== request.leg ||
        task.version !== request.expected_delivery_task_version ||
        task.status !== "accepted" ||
        task.assignee_staff_id !== request.staff_id ||
        !deliveryEvidenceOrderStatusAllowsRecord(request.leg, order.status)
      ) {
        return Object.freeze({ ok: false, reason: "authority" });
      }
      const attachment = attachmentFromRequest(request);
      attachments.set(
        scopedKey(request.org_id, request.store_id, request.attachment_id),
        attachment,
      );
      return Object.freeze({ ok: true, attachment, replay: false });
    },
    async record(request) {
      if (
        evidenceRows.has(scopedKey(request.org_id, request.store_id, request.delivery_evidence_id))
      ) {
        return Object.freeze({ ok: false, reason: "duplicate" });
      }
      const prepared = await authority(request);
      if (prepared === null || !sameEvidenceAuthority(prepared, request.authority)) {
        return Object.freeze({ ok: false, reason: "authority" });
      }
      let order = await orders.get(request.org_id, request.store_id, request.delivery_order_id);
      if (order === null) return Object.freeze({ ok: false, reason: "authority" });
      if (request.outcome === "complete_leg") {
        const transitioned = await orders.transition({
          org_id: request.org_id,
          store_id: request.store_id,
          staff_id: request.staff_id,
          delivery_order_id: request.delivery_order_id,
          customer_id: order.customer_id,
          expected_version: order.version,
          target_status: deliveryEvidenceCompletionTarget(request.leg),
          cancellation_reason: null,
          at: request.at,
        });
        if (!transitioned.ok) return Object.freeze({ ok: false, reason: "conflict" });
        order = transitioned.delivery_order;
      }
      const task = await tasks.get(request.org_id, request.store_id, request.delivery_task_id);
      if (task === null) return Object.freeze({ ok: false, reason: "conflict" });
      const selected = request.attachment_ids.map((id) =>
        attachments.get(scopedKey(request.org_id, request.store_id, id))!,
      );
      const evidence = freezeEvidence({
        delivery_evidence_id: request.delivery_evidence_id,
        delivery_order_id: request.delivery_order_id,
        delivery_task_id: request.delivery_task_id,
        leg: request.leg,
        delivery_task_version: request.expected_delivery_task_version,
        assignee_staff_id: request.staff_id,
        event_kind: request.event_kind,
        outcome: request.outcome,
        exception_reason: request.exception_reason ?? null,
        captured_at: request.captured_at,
        gps: request.gps,
        attachments: selected.map(publicAttachment),
        recorded_at: request.at,
      });
      evidenceRows.set(
        scopedKey(request.org_id, request.store_id, request.delivery_evidence_id),
        Object.freeze({ org_id: request.org_id, store_id: request.store_id, evidence }),
      );
      return Object.freeze({ ok: true, evidence, delivery_order: order, delivery_task: task });
    },
    async list(orgId, storeId, staffId, taskId, limit) {
      const task = await tasks.get(orgId, storeId, taskId);
      if (
        task === null ||
        task.assignee_staff_id !== staffId ||
        !["accepted", "completed"].includes(task.status)
      ) {
        return Object.freeze([]);
      }
      return Object.freeze(
        [...evidenceRows.values()]
          .filter(
            (row) =>
              row.org_id === orgId &&
              row.store_id === storeId &&
              row.evidence.delivery_task_id === taskId,
          )
          .map(({ evidence }) => evidence)
          .sort((left, right) => right.recorded_at - left.recorded_at)
          .slice(0, limit),
      );
    },
    async authorizedAttachment(orgId, storeId, staffId, attachmentId) {
      const attachment = attachments.get(scopedKey(orgId, storeId, attachmentId));
      if (attachment === undefined) return null;
      const task = await tasks.get(orgId, storeId, attachment.delivery_task_id);
      const linked = [...evidenceRows.values()].some(({ evidence }) =>
        evidence.attachments.some((item) => item.attachment_id === attachmentId),
      );
      return linked &&
        task?.assignee_staff_id === staffId &&
        ["accepted", "completed"].includes(task.status)
        ? attachment
        : null;
    },
    async uploadedAttachment(orgId, storeId, staffId, attachmentId) {
      const attachment = attachments.get(scopedKey(orgId, storeId, attachmentId));
      return attachment?.created_by_staff_id === staffId ? attachment : null;
    },
    async referencedStorageKeys(orgId, storeId) {
      const linkedIds = new Set(
        [...evidenceRows.values()]
          .filter((row) => row.org_id === orgId && row.store_id === storeId)
          .flatMap(({ evidence }) =>
            evidence.attachments.map(({ attachment_id }) => attachment_id),
          ),
      );
      const now = Math.floor(Date.now() / 1_000);
      return new Set(
        [...attachments.values()]
          .filter((row) => row.org_id === orgId && row.store_id === storeId)
          .filter((row) => row.expires_at >= now || linkedIds.has(row.attachment_id))
          .map(({ storage_key }) => storage_key),
      );
    },
  });
}
