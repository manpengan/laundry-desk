import type { DeliveryOrder, DeliveryTask } from "@laundry/contracts";
import { deliveryTaskAssignableOrderStatus, deliveryTaskLegMatchesRoute } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { freezeDeliveryTask, type DeliveryTaskPrepareRequest } from "./types.js";

export type DeliveryTaskRow = Readonly<{
  delivery_task_id: string;
  delivery_order_id: string;
  leg: DeliveryTask["leg"];
  assignee_staff_id: string;
  assigned_by_staff_id: string;
  predecessor_task_id: string | null;
  source: DeliveryTask["source"];
  status: DeliveryTask["status"];
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  accepted_at: Date | string | null;
  rejected_at: Date | string | null;
  transferred_at: Date | string | null;
  taken_over_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  resolution_reason: DeliveryTask["resolution_reason"];
}>;

export type DeliveryOrderTaskRow = Readonly<{
  delivery_order_id: string;
  collection_method: DeliveryOrder["collection_method"];
  return_method: DeliveryOrder["return_method"];
  status: DeliveryOrder["status"];
  version: number;
}>;

export const DELIVERY_TASK_COLUMNS = `id::text AS delivery_task_id,
       delivery_order_id::text, leg, assignee_staff_id::text, assigned_by_staff_id::text,
       predecessor_task_id::text, source, status, version, created_at, updated_at,
       accepted_at, rejected_at, transferred_at, taken_over_at, completed_at,
       cancelled_at, resolution_reason`;

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);

const nullableEpoch = (value: Date | string | null): number | null =>
  value === null ? null : epoch(value);

export function mapDeliveryTask(row: DeliveryTaskRow): DeliveryTask {
  return freezeDeliveryTask({
    ...row,
    created_at: epoch(row.created_at),
    updated_at: epoch(row.updated_at),
    accepted_at: nullableEpoch(row.accepted_at),
    rejected_at: nullableEpoch(row.rejected_at),
    transferred_at: nullableEpoch(row.transferred_at),
    taken_over_at: nullableEpoch(row.taken_over_at),
    completed_at: nullableEpoch(row.completed_at),
    cancelled_at: nullableEpoch(row.cancelled_at),
  });
}

export async function lockDeliveryOrder(
  client: SqlClient,
  request: DeliveryTaskPrepareRequest,
): Promise<DeliveryOrderTaskRow | null> {
  const result = await client.query<DeliveryOrderTaskRow>(
    `SELECT id::text AS delivery_order_id, collection_method, return_method, status, version
       FROM delivery_orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [request.org_id, request.store_id, request.delivery_order_id],
  );
  return result.rows[0] ?? null;
}

export function orderSupportsTask(
  order: DeliveryOrderTaskRow,
  leg: DeliveryTask["leg"],
  initial: boolean,
): boolean {
  if (
    !deliveryTaskLegMatchesRoute(leg, {
      collectionMethod: order.collection_method,
      returnMethod: order.return_method,
    })
  ) {
    return false;
  }
  const scheduled = deliveryTaskAssignableOrderStatus(leg);
  return initial
    ? order.status === scheduled
    : order.status === scheduled ||
        (leg === "pickup"
          ? order.status === "pickup_in_progress"
          : order.status === "return_in_progress");
}

export async function lockTask(
  client: SqlClient,
  request: Exclude<DeliveryTaskPrepareRequest, Readonly<{ operation: "assign" }>>,
): Promise<DeliveryTask | null> {
  const result = await client.query<DeliveryTaskRow>(
    `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [request.org_id, request.store_id, request.delivery_task_id],
  );
  return result.rows[0] === undefined ? null : mapDeliveryTask(result.rows[0]);
}

export async function activeTaskForLeg(
  client: SqlClient,
  request: DeliveryTaskPrepareRequest,
): Promise<DeliveryTask | null> {
  const result = await client.query<DeliveryTaskRow>(
    `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND delivery_order_id = $3::uuid AND leg = $4
        AND status IN ('offered', 'accepted')
      FOR UPDATE`,
    [request.org_id, request.store_id, request.delivery_order_id, request.leg],
  );
  return result.rows[0] === undefined ? null : mapDeliveryTask(result.rows[0]);
}

export async function latestReusablePredecessor(
  client: SqlClient,
  request: DeliveryTaskPrepareRequest,
): Promise<DeliveryTask | null> {
  const result = await client.query<DeliveryTaskRow>(
    `SELECT ${DELIVERY_TASK_COLUMNS} FROM delivery_tasks candidate
      WHERE candidate.org_id = $1::uuid AND candidate.store_id = $2::uuid
        AND candidate.delivery_order_id = $3::uuid AND candidate.leg = $4
        AND candidate.status IN ('rejected', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM delivery_tasks successor
           WHERE successor.org_id = candidate.org_id AND successor.store_id = candidate.store_id
             AND successor.predecessor_task_id = candidate.id
        )
      ORDER BY candidate.updated_at DESC, candidate.id DESC
      LIMIT 1
      FOR SHARE OF candidate`,
    [request.org_id, request.store_id, request.delivery_order_id, request.leg],
  );
  return result.rows[0] === undefined ? null : mapDeliveryTask(result.rows[0]);
}

export async function activeStaff(
  client: SqlClient,
  request: Pick<DeliveryTaskPrepareRequest, "org_id" | "store_id">,
  staffId: string,
  adminOnly: boolean,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM staff_store_roles role_row
       JOIN staffs staff_row
         ON staff_row.org_id = role_row.org_id AND staff_row.id = role_row.staff_id
      WHERE role_row.org_id = $1::uuid AND role_row.store_id = $2::uuid
        AND role_row.staff_id = $3::uuid AND role_row.is_active AND staff_row.is_active
        AND ($4::boolean = false OR role_row.role = 'admin')
      FOR SHARE OF role_row, staff_row`,
    [request.org_id, request.store_id, staffId, adminOnly],
  );
  return result.rows.length === 1;
}
