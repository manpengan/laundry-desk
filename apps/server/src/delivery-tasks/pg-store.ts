import type { DeliveryTask } from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import { preparePgTaskAuthority } from "./pg-authority.js";
import { DELIVERY_TASK_COLUMNS, mapDeliveryTask, type DeliveryTaskRow } from "./pg-support.js";
import type {
  DeliveryTaskMutationRequest,
  DeliveryTaskMutationResult,
  DeliveryTaskStore,
} from "./types.js";

async function insertTask(
  client: SqlClient,
  input: Readonly<{
    request: DeliveryTaskMutationRequest;
    deliveryTaskId: string;
    assigneeStaffId: string;
    predecessorTaskId: string | null;
    source: DeliveryTask["source"];
    status: "offered" | "accepted";
  }>,
): Promise<DeliveryTask> {
  const { request } = input;
  const result = await client.query<DeliveryTaskRow>(
    `INSERT INTO delivery_tasks (
       id, org_id, store_id, delivery_order_id, leg, assignee_staff_id,
       assigned_by_staff_id, predecessor_task_id, source, status, version,
       resolution_reason, accepted_at, rejected_at, transferred_at, taken_over_at,
       completed_at, cancelled_at, created_at, updated_at,
       created_by_staff_id, updated_by_staff_id
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10,1,
       NULL,NULL,NULL,NULL,NULL,NULL,NULL,$11::timestamptz,$11::timestamptz,$7::uuid,$7::uuid
     ) RETURNING ${DELIVERY_TASK_COLUMNS}`,
    [
      input.deliveryTaskId,
      request.org_id,
      request.store_id,
      request.delivery_order_id,
      request.leg,
      input.assigneeStaffId,
      request.staff_id,
      input.predecessorTaskId,
      input.source,
      input.status,
      new Date(request.at * 1_000),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Inserted delivery task disappeared");
  return mapDeliveryTask(row);
}

async function updateTask(
  client: SqlClient,
  request: Exclude<DeliveryTaskMutationRequest, Readonly<{ operation: "assign" }>>,
  status: DeliveryTask["status"],
): Promise<DeliveryTask | null> {
  const reason =
    request.operation === "respond"
      ? request.resolution_reason
      : request.operation === "transfer" || request.operation === "takeover"
        ? request.resolution_reason
        : null;
  const result = await client.query<DeliveryTaskRow>(
    `UPDATE delivery_tasks
        SET status = $6, version = version + 1, resolution_reason = $7,
            updated_at = $8::timestamptz, updated_by_staff_id = $9::uuid
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND delivery_order_id = $4::uuid AND leg = $5 AND version = $10
        AND status IN ('offered', 'accepted')
      RETURNING ${DELIVERY_TASK_COLUMNS}`,
    [
      request.org_id,
      request.store_id,
      request.delivery_task_id,
      request.delivery_order_id,
      request.leg,
      status,
      reason,
      new Date(request.at * 1_000),
      request.staff_id,
      request.expected_version,
    ],
  );
  return result.rows[0] === undefined ? null : mapDeliveryTask(result.rows[0]);
}

async function mutate(
  client: SqlClient,
  request: DeliveryTaskMutationRequest,
): Promise<DeliveryTaskMutationResult> {
  const prepared = await preparePgTaskAuthority(client, request);
  if (
    prepared === null ||
    prepared.summary.delivery_order_version !== request.expected_delivery_order_version
  ) {
    return Object.freeze({ ok: false, reason: "state_conflict" });
  }
  if (request.operation === "assign") {
    const task = await insertTask(client, {
      request,
      deliveryTaskId: request.delivery_task_id,
      assigneeStaffId: request.assignee_staff_id,
      predecessorTaskId: prepared.predecessor?.delivery_task_id ?? null,
      source: "assignment",
      status: "offered",
    });
    return Object.freeze({
      ok: true,
      delivery_task: task,
      previous_task: prepared.predecessor,
      before: null,
    });
  }
  const before = prepared.task;
  if (before === null) return Object.freeze({ ok: false, reason: "not_found" });
  if (request.operation === "respond") {
    const updated = await updateTask(
      client,
      request,
      request.decision === "accept" ? "accepted" : "rejected",
    );
    return updated === null
      ? Object.freeze({ ok: false, reason: "state_conflict" })
      : Object.freeze({ ok: true, delivery_task: updated, previous_task: null, before });
  }
  const previous = await updateTask(
    client,
    request,
    request.operation === "transfer" ? "transferred" : "taken_over",
  );
  if (previous === null) return Object.freeze({ ok: false, reason: "state_conflict" });
  const successor = await insertTask(client, {
    request,
    deliveryTaskId: request.successor_task_id,
    assigneeStaffId: request.operation === "takeover" ? request.staff_id : request.target_staff_id,
    predecessorTaskId: before.delivery_task_id,
    source: request.operation,
    status: request.operation === "takeover" ? "accepted" : "offered",
  });
  return Object.freeze({
    ok: true,
    delivery_task: successor,
    previous_task: previous,
    before,
  });
}

function listQuery(filter: Parameters<DeliveryTaskStore["list"]>[2]) {
  const conditions = ["org_id = $1::uuid", "store_id = $2::uuid"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length + 2}`));
  };
  if (filter.delivery_order_id !== undefined)
    add("delivery_order_id = ?::uuid", filter.delivery_order_id);
  if (filter.leg !== undefined) add("leg = ?", filter.leg);
  if (filter.assignee_staff_id !== undefined)
    add("assignee_staff_id = ?::uuid", filter.assignee_staff_id);
  if (filter.status !== undefined) add("status = ?", filter.status);
  if (filter.active_only === true) conditions.push("status IN ('offered', 'accepted')");
  values.push(filter.limit);
  return Object.freeze({
    sql: `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks
           WHERE ${conditions.join(" AND ")}
           ORDER BY updated_at DESC, id
           LIMIT $${values.length + 2}`,
    values,
  });
}

export function createPgDeliveryTaskStore(pool: PgPool): DeliveryTaskStore {
  return Object.freeze({
    prepare: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        async (client) => (await preparePgTaskAuthority(client, request))?.summary ?? null,
      ),
    mutate: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => mutate(client, request),
      ),
    get: (orgId, storeId, taskId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<DeliveryTaskRow>(
          `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [orgId, storeId, taskId],
        );
        return result.rows[0] === undefined ? null : mapDeliveryTask(result.rows[0]);
      }),
    list: (orgId, storeId, filter) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const query = listQuery(filter);
        const result = await client.query<DeliveryTaskRow>(query.sql, [
          orgId,
          storeId,
          ...query.values,
        ]);
        return Object.freeze(result.rows.map(mapDeliveryTask));
      }),
    canExecuteOrderTransition: (orgId, storeId, deliveryOrderId, leg, staffId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId, staffId }, async (client) => {
        const result = await client.query(
          `SELECT 1 FROM delivery_tasks
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND delivery_order_id = $3::uuid AND leg = $4
              AND status = 'accepted' AND assignee_staff_id = $5::uuid`,
          [orgId, storeId, deliveryOrderId, leg, staffId],
        );
        return result.rows.length === 1;
      }),
    settleOrderTransition: async () => undefined,
  });
}
