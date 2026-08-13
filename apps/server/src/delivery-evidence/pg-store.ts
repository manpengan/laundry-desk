import type { DeliveryTask } from "@laundry/contracts";
import {
  deliveryEvidenceCompletionTarget,
  deliveryEvidenceOrderStatusAllowsCompletion,
  deliveryEvidenceOrderStatusAllowsRecord,
  hasRequiredDeliveryEvidence,
} from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import {
  DELIVERY_ORDER_COLUMNS,
  mapDeliveryOrder,
  type DeliveryOrderRow,
} from "../delivery-orders/pg-support.js";
import {
  DELIVERY_TASK_COLUMNS,
  mapDeliveryTask,
  type DeliveryTaskRow,
} from "../delivery-tasks/pg-support.js";
import {
  attachmentSetDigest,
  freezeEvidenceConfirmation,
  sameEvidenceAuthority,
  type DeliveryAttachmentRegisterRequest,
  type DeliveryEvidencePrepareRequest,
  type DeliveryEvidenceStore,
} from "./types.js";
import {
  DELIVERY_ATTACHMENT_COLUMNS,
  DELIVERY_ATTACHMENT_JOIN_COLUMNS,
  DELIVERY_EVIDENCE_COLUMNS,
  mapDeliveryAttachment,
  mapDeliveryEvidence,
  type DeliveryAttachmentRow,
  type DeliveryEvidenceRow,
} from "./pg-support.js";

async function lockAuthority(client: SqlClient, request: DeliveryEvidencePrepareRequest) {
  const orderResult = await client.query<DeliveryOrderRow>(
    `SELECT ${DELIVERY_ORDER_COLUMNS} FROM delivery_orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [request.org_id, request.store_id, request.delivery_order_id],
  );
  const orderRow = orderResult.rows[0];
  if (orderRow === undefined) return null;
  const order = mapDeliveryOrder(orderRow);
  const taskResult = await client.query<DeliveryTaskRow>(
    `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [request.org_id, request.store_id, request.delivery_task_id],
  );
  const taskRow = taskResult.rows[0];
  if (taskRow === undefined) return null;
  const task = mapDeliveryTask(taskRow);
  if (
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
  const attachmentResult = await client.query<DeliveryAttachmentRow>(
    `SELECT ${DELIVERY_ATTACHMENT_COLUMNS} FROM delivery_evidence_attachments
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND id = ANY($3::uuid[]) AND expires_at >= statement_timestamp()
      ORDER BY id`,
    [request.org_id, request.store_id, request.attachment_ids],
  );
  const attachments = attachmentResult.rows.map(mapDeliveryAttachment);
  if (
    attachments.length !== request.attachment_ids.length ||
    attachments.some(
      (row) =>
        row.delivery_order_id !== order.delivery_order_id ||
        row.delivery_task_id !== task.delivery_task_id ||
        row.delivery_task_version !== task.version ||
        row.leg !== task.leg ||
        row.created_by_staff_id !== request.staff_id,
    ) ||
    !hasRequiredDeliveryEvidence({
      leg: request.leg,
      outcome: request.outcome,
      eventKind: request.event_kind,
      taskStatus: task.status,
      hasGps: request.gps !== null,
      attachmentKinds: attachments.map(({ kind }) => kind),
    })
  ) {
    return null;
  }
  const summary = freezeEvidenceConfirmation({
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
    photo_count: attachments.filter(({ kind }) => kind === "photo").length,
    signature_count: attachments.filter(({ kind }) => kind === "signature").length,
    attachment_set_digest: attachmentSetDigest(request.attachment_ids),
  });
  return Object.freeze({ order, task, attachments, summary });
}

async function updateOrder(
  client: SqlClient,
  request: DeliveryEvidencePrepareRequest,
): Promise<DeliveryOrderRow | null> {
  const result = await client.query<DeliveryOrderRow>(
    `UPDATE delivery_orders
        SET status = $4, version = version + 1, cancellation_reason = NULL,
            updated_at = $5::timestamptz, updated_by_staff_id = $6::uuid
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND version = $7
      RETURNING ${DELIVERY_ORDER_COLUMNS}`,
    [
      request.org_id,
      request.store_id,
      request.delivery_order_id,
      deliveryEvidenceCompletionTarget(request.leg),
      new Date(request.at * 1_000),
      request.staff_id,
      request.expected_delivery_order_version,
    ],
  );
  return result.rows[0] ?? null;
}

async function recordEvidence(
  client: SqlClient,
  request: Parameters<DeliveryEvidenceStore["record"]>[0],
) {
  const prepared = await lockAuthority(client, request);
  if (prepared === null || !sameEvidenceAuthority(prepared.summary, request.authority)) {
    return Object.freeze({ ok: false as const, reason: "authority" as const });
  }
  const inserted = await client.query<DeliveryEvidenceRow>(
    `INSERT INTO delivery_evidence_events (
       id, org_id, store_id, delivery_order_id, delivery_task_id, leg,
       delivery_task_version, assignee_staff_id, event_kind, outcome, exception_reason,
       captured_at, latitude_e7, longitude_e7, accuracy_mm, gps_captured_at,
       recorded_at, recorded_by_staff_id
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::uuid,$9,$10,$11,
       $12::timestamptz,$13,$14,$15,$16::timestamptz,$17::timestamptz,$8::uuid
     ) RETURNING ${DELIVERY_EVIDENCE_COLUMNS}`,
    [
      request.delivery_evidence_id,
      request.org_id,
      request.store_id,
      request.delivery_order_id,
      request.delivery_task_id,
      request.leg,
      request.expected_delivery_task_version,
      request.staff_id,
      request.event_kind,
      request.outcome,
      request.exception_reason ?? null,
      new Date(request.captured_at * 1_000),
      request.gps?.latitude_e7 ?? null,
      request.gps?.longitude_e7 ?? null,
      request.gps?.accuracy_mm ?? null,
      request.gps === null ? null : new Date(request.gps.captured_at * 1_000),
      new Date(request.at * 1_000),
    ],
  );
  const eventRow = inserted.rows[0];
  if (eventRow === undefined) throw new Error("Inserted delivery evidence disappeared");
  for (const attachment of prepared.attachments) {
    await client.query(
      `INSERT INTO delivery_evidence_attachment_links (
         org_id, store_id, delivery_evidence_id, attachment_id, linked_at, linked_by_staff_id
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::uuid)`,
      [
        request.org_id,
        request.store_id,
        request.delivery_evidence_id,
        attachment.attachment_id,
        new Date(request.at * 1_000),
        request.staff_id,
      ],
    );
  }
  let order = prepared.order;
  if (request.outcome === "complete_leg") {
    const updated = await updateOrder(client, request);
    if (updated === null) return Object.freeze({ ok: false as const, reason: "conflict" as const });
    order = mapDeliveryOrder(updated);
  }
  const taskResult = await client.query<DeliveryTaskRow>(
    `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [request.org_id, request.store_id, request.delivery_task_id],
  );
  const task = taskResult.rows[0] === undefined ? null : mapDeliveryTask(taskResult.rows[0]);
  if (task === null) throw new Error("Delivery evidence task disappeared");
  return Object.freeze({
    ok: true as const,
    evidence: mapDeliveryEvidence(eventRow, prepared.attachments),
    delivery_order: order,
    delivery_task: task,
  });
}

async function registerAttachment(client: SqlClient, request: DeliveryAttachmentRegisterRequest) {
  const inserted = await client.query<DeliveryAttachmentRow>(
    `INSERT INTO delivery_evidence_attachments (
       id, org_id, store_id, delivery_order_id, delivery_task_id, leg,
       delivery_task_version, assignee_staff_id, kind, storage_key, content_type,
       content_sha256, byte_size, captured_at, expires_at, created_at, created_by_staff_id
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::uuid,$9,$10,$11,
       $12,$13,$14::timestamptz,$15::timestamptz,$15::timestamptz,$8::uuid
     ) ON CONFLICT (id) DO NOTHING RETURNING ${DELIVERY_ATTACHMENT_COLUMNS}`,
    [
      request.attachment_id,
      request.org_id,
      request.store_id,
      request.delivery_order_id,
      request.delivery_task_id,
      request.leg,
      request.expected_delivery_task_version,
      request.staff_id,
      request.kind,
      request.storage_key,
      request.content_type,
      request.content_sha256,
      request.byte_size,
      new Date(request.captured_at * 1_000),
      new Date(request.at * 1_000),
    ],
  );
  const created = inserted.rows[0];
  if (created !== undefined) {
    return Object.freeze({
      ok: true as const,
      attachment: mapDeliveryAttachment(created),
      replay: false,
    });
  }
  const existingResult = await client.query<DeliveryAttachmentRow>(
    `SELECT ${DELIVERY_ATTACHMENT_COLUMNS} FROM delivery_evidence_attachments
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [request.org_id, request.store_id, request.attachment_id],
  );
  const existing =
    existingResult.rows[0] === undefined ? null : mapDeliveryAttachment(existingResult.rows[0]);
  const matches =
    existing !== null &&
    existing.delivery_order_id === request.delivery_order_id &&
    existing.delivery_task_id === request.delivery_task_id &&
    existing.delivery_task_version === request.expected_delivery_task_version &&
    existing.leg === request.leg &&
    existing.kind === request.kind &&
    existing.content_sha256 === request.content_sha256 &&
    existing.byte_size === request.byte_size &&
    existing.captured_at === request.captured_at &&
    existing.created_by_staff_id === request.staff_id;
  return matches
    ? Object.freeze({ ok: true as const, attachment: existing, replay: true })
    : Object.freeze({ ok: false as const, reason: "conflict" as const });
}

async function listEvidence(
  client: SqlClient,
  orgId: string,
  storeId: string,
  staffId: string,
  taskId: string,
  limit: number,
) {
  const taskAuthority = await client.query<Pick<DeliveryTask, "status">>(
    `SELECT status FROM delivery_tasks WHERE org_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND assignee_staff_id = $4::uuid AND status IN ('accepted','completed')`,
    [orgId, storeId, taskId, staffId],
  );
  if (taskAuthority.rows.length !== 1) return Object.freeze([]);
  const rows = await client.query<DeliveryEvidenceRow>(
    `SELECT ${DELIVERY_EVIDENCE_COLUMNS} FROM delivery_evidence_events
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND delivery_task_id = $3::uuid
      ORDER BY recorded_at DESC, id LIMIT $4`,
    [orgId, storeId, taskId, limit],
  );
  const result = [];
  for (const row of rows.rows) {
    const attachmentRows = await client.query<DeliveryAttachmentRow>(
      `SELECT ${DELIVERY_ATTACHMENT_JOIN_COLUMNS} FROM delivery_evidence_attachments attachment
       JOIN delivery_evidence_attachment_links link
         ON link.org_id = attachment.org_id AND link.store_id = attachment.store_id
        AND link.attachment_id = attachment.id
       WHERE link.org_id = $1::uuid AND link.store_id = $2::uuid
         AND link.delivery_evidence_id = $3::uuid ORDER BY attachment.id`,
      [orgId, storeId, row.delivery_evidence_id],
    );
    result.push(mapDeliveryEvidence(row, attachmentRows.rows.map(mapDeliveryAttachment)));
  }
  return Object.freeze(result);
}

export function createPgDeliveryEvidenceStore(pool: PgPool): DeliveryEvidenceStore {
  return Object.freeze({
    prepare: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        async (client) => (await lockAuthority(client, request))?.summary ?? null,
      ),
    record: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => recordEvidence(client, request),
      ),
    registerAttachment: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => registerAttachment(client, request),
      ),
    list: (orgId, storeId, staffId, taskId, limit) =>
      withStoreGucOrCurrent(pool, { orgId, storeId, staffId }, (client) =>
        listEvidence(client, orgId, storeId, staffId, taskId, limit),
      ),
    authorizedAttachment: (orgId, storeId, staffId, attachmentId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId, staffId }, async (client) => {
        const result = await client.query<DeliveryAttachmentRow>(
          `SELECT ${DELIVERY_ATTACHMENT_JOIN_COLUMNS} FROM delivery_evidence_attachments attachment
           JOIN delivery_evidence_attachment_links link
             ON link.org_id = attachment.org_id AND link.store_id = attachment.store_id
            AND link.attachment_id = attachment.id
           JOIN delivery_tasks task
             ON task.org_id = attachment.org_id AND task.store_id = attachment.store_id
            AND task.id = attachment.delivery_task_id
           WHERE attachment.org_id = $1::uuid AND attachment.store_id = $2::uuid
             AND attachment.id = $3::uuid AND task.assignee_staff_id = $4::uuid
             AND task.status IN ('accepted','completed')`,
          [orgId, storeId, attachmentId, staffId],
        );
        return result.rows[0] === undefined ? null : mapDeliveryAttachment(result.rows[0]);
      }),
    uploadedAttachment: (orgId, storeId, staffId, attachmentId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId, staffId }, async (client) => {
        const result = await client.query<DeliveryAttachmentRow>(
          `SELECT ${DELIVERY_ATTACHMENT_COLUMNS} FROM delivery_evidence_attachments
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              AND created_by_staff_id = $4::uuid`,
          [orgId, storeId, attachmentId, staffId],
        );
        return result.rows[0] === undefined ? null : mapDeliveryAttachment(result.rows[0]);
      }),
    referencedStorageKeys: (orgId, storeId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<Readonly<{ storage_key: string }>>(
          `SELECT storage_key FROM delivery_evidence_attachments attachment
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND (expires_at >= statement_timestamp() OR EXISTS (
                SELECT 1 FROM delivery_evidence_attachment_links link
                 WHERE link.org_id = attachment.org_id AND link.store_id = attachment.store_id
                   AND link.attachment_id = attachment.id
              ))`,
          [orgId, storeId],
        );
        return new Set(result.rows.map(({ storage_key }) => storage_key));
      }),
  });
}
