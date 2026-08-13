import { canTransitionDeliveryOrder, initialDeliveryOrderStatus } from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import { DELIVERY_ORDER_COLUMNS, mapDeliveryOrder, type DeliveryOrderRow } from "./pg-support.js";
import { deliveryOrderListQuery } from "./pg-list-query.js";
import type {
  DeliveryOrderCreateRequest,
  DeliveryOrderMutationResult,
  DeliveryOrderStore,
  DeliveryOrderTransitionRequest,
} from "./types.js";

type LinkedOrder = Readonly<{
  customer_id: string;
  status: "draft" | "open" | "closed" | "cancelled";
  balance_cents: number;
}>;
type LinkedAppointment = Readonly<{
  customer_id: string;
  direction: "pickup" | "return";
  status: "scheduled" | "cancelled";
  fee_cents: number;
}>;
type GarmentAuthority = Readonly<{
  status: string;
  custody_state: string;
  active_production_batch_id: string | null;
}>;

async function linkedOrder(
  client: SqlClient,
  orgId: string,
  storeId: string,
  laundryOrderId: string,
): Promise<LinkedOrder | null> {
  const result = await client.query<LinkedOrder>(
    `SELECT root.id::text AS customer_id, order_row.status, order_row.balance_cents
       FROM orders order_row
       JOIN customers requested
         ON requested.org_id = order_row.org_id AND requested.id = order_row.customer_id
       JOIN customers root
         ON root.org_id = requested.org_id
        AND root.id = customer_canonical_root(requested.id)
      WHERE order_row.org_id = $1::uuid AND order_row.store_id = $2::uuid
        AND order_row.id = $3::uuid
        AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
      FOR SHARE OF order_row, requested, root`,
    [orgId, storeId, laundryOrderId],
  );
  return result.rows[0] ?? null;
}

async function linkedAppointment(
  client: SqlClient,
  request: DeliveryOrderCreateRequest,
  appointmentId: string | null,
): Promise<LinkedAppointment | null> {
  if (appointmentId === null) return null;
  const result = await client.query<LinkedAppointment>(
    `SELECT customer_canonical_root(appointment.customer_id)::text AS customer_id,
            appointment.direction, appointment.status, appointment.fee_cents
       FROM delivery_appointments appointment
       JOIN customer_canonical_group(appointment.customer_id) canonical ON true
       JOIN customer_addresses address_row
         ON address_row.org_id = appointment.org_id
        AND address_row.customer_id = canonical.group_customer_id
        AND address_row.id = appointment.address_id
      WHERE appointment.org_id = $1::uuid AND appointment.store_id = $2::uuid
        AND appointment.id = $3::uuid
        AND address_row.retired_at IS NULL AND address_row.pii_purged_at IS NULL
      FOR SHARE OF appointment, address_row`,
    [request.org_id, request.store_id, appointmentId],
  );
  return result.rows[0] ?? null;
}

async function deliveryEnabled(
  client: SqlClient,
  orgId: string,
  storeId: string,
): Promise<boolean> {
  const result = await client.query<Readonly<{ delivery: boolean }>>(
    `SELECT delivery FROM store_features
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      FOR SHARE`,
    [orgId, storeId],
  );
  return result.rows[0]?.delivery === true;
}

async function deriveCreate(client: SqlClient, request: DeliveryOrderCreateRequest) {
  if (!(await deliveryEnabled(client, request.org_id, request.store_id))) {
    return Object.freeze({ ok: false as const, reason: "feature_disabled" as const });
  }
  const order = await linkedOrder(
    client,
    request.org_id,
    request.store_id,
    request.laundry_order_id,
  );
  const requestedCustomer = await client.query<Readonly<{ customer_id: string | null }>>(
    "SELECT customer_canonical_root($1::uuid)::text AS customer_id",
    [request.customer_id],
  );
  if (
    order === null ||
    requestedCustomer.rows[0]?.customer_id !== order.customer_id ||
    (request.collection_method === "pickup" ? order.status !== "draft" : order.status !== "open")
  ) {
    return Object.freeze({ ok: false as const, reason: "link_invalid" as const });
  }
  const [pickup, deliveryReturn] = await Promise.all([
    linkedAppointment(client, request, request.pickup_appointment_id),
    linkedAppointment(client, request, request.return_appointment_id),
  ]);
  const pickupValid =
    request.collection_method === "pickup"
      ? pickup?.status === "scheduled" &&
        pickup.direction === "pickup" &&
        pickup.customer_id === order.customer_id
      : pickup === null;
  const returnValid =
    request.return_method === "delivery"
      ? deliveryReturn?.status === "scheduled" &&
        deliveryReturn.direction === "return" &&
        deliveryReturn.customer_id === order.customer_id
      : deliveryReturn === null;
  const pickupFee = pickup?.fee_cents ?? 0;
  const returnFee = deliveryReturn?.fee_cents ?? 0;
  if (!pickupValid || !returnValid || pickupFee + returnFee > 2_147_483_647) {
    return Object.freeze({ ok: false as const, reason: "link_invalid" as const });
  }
  return Object.freeze({
    ok: true as const,
    customer_id: order.customer_id,
    pickup_fee_cents: pickupFee,
    return_fee_cents: returnFee,
    status: initialDeliveryOrderStatus({
      collectionMethod: request.collection_method,
      returnMethod: request.return_method,
    }),
  });
}

async function createDeliveryOrder(
  client: SqlClient,
  request: DeliveryOrderCreateRequest,
): Promise<DeliveryOrderMutationResult> {
  const derived = await deriveCreate(client, request);
  if (!derived.ok) return derived;
  const result = await client.query<DeliveryOrderRow>(
    `INSERT INTO delivery_orders (
       id, org_id, store_id, laundry_order_id, customer_id,
       collection_method, return_method, pickup_appointment_id, return_appointment_id,
       pickup_fee_cents, return_fee_cents, total_fee_cents, status, version,
       created_at, updated_at, created_by_staff_id, updated_by_staff_id
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::uuid,$9::uuid,
       $10,$11,$12,$13,1,$14,$14,$15::uuid,$15::uuid
     ) ON CONFLICT DO NOTHING
     RETURNING ${DELIVERY_ORDER_COLUMNS}`,
    [
      request.delivery_order_id,
      request.org_id,
      request.store_id,
      request.laundry_order_id,
      derived.customer_id,
      request.collection_method,
      request.return_method,
      request.pickup_appointment_id,
      request.return_appointment_id,
      derived.pickup_fee_cents,
      derived.return_fee_cents,
      derived.pickup_fee_cents + derived.return_fee_cents,
      derived.status,
      new Date(request.at * 1_000),
      request.staff_id,
    ],
  );
  const row = result.rows[0];
  return row === undefined
    ? Object.freeze({ ok: false, reason: "duplicate" })
    : Object.freeze({ ok: true, delivery_order: mapDeliveryOrder(row), before: null });
}

async function loadLocked(
  client: SqlClient,
  orgId: string,
  storeId: string,
  deliveryOrderId: string,
): Promise<DeliveryOrderRow | null> {
  const result = await client.query<DeliveryOrderRow>(
    `SELECT ${DELIVERY_ORDER_COLUMNS} FROM delivery_orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [orgId, storeId, deliveryOrderId],
  );
  return result.rows[0] ?? null;
}

async function garmentAuthority(
  client: SqlClient,
  orgId: string,
  storeId: string,
  laundryOrderId: string,
): Promise<readonly GarmentAuthority[]> {
  const result = await client.query<GarmentAuthority>(
    `SELECT status, custody_state, active_production_batch_id::text
       FROM garments
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
      ORDER BY id
      FOR SHARE`,
    [orgId, storeId, laundryOrderId],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
}

async function fulfillmentEnabled(
  client: SqlClient,
  orgId: string,
  storeId: string,
): Promise<boolean> {
  const result = await client.query<Readonly<{ fulfillment: boolean }>>(
    `SELECT fulfillment FROM store_features
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      FOR SHARE`,
    [orgId, storeId],
  );
  return result.rows[0]?.fulfillment !== false;
}

function atStoreReady(
  garments: readonly GarmentAuthority[],
  target: DeliveryOrderTransitionRequest["target_status"],
  detailedFulfillment: boolean,
): boolean {
  return (
    garments.length > 0 &&
    garments.every((garment) => {
      if (garment.active_production_batch_id !== null) return false;
      if (garment.status === "lost") return garment.custody_state === "exception";
      if (garment.custody_state !== "store") return false;
      if (!detailedFulfillment && garment.status === "received") return true;
      return target === "self_pickup_ready"
        ? garment.status === "racked"
        : garment.status === "ready" || garment.status === "racked";
    })
  );
}

async function transitionAuthority(
  client: SqlClient,
  request: DeliveryOrderTransitionRequest,
  current: ReturnType<typeof mapDeliveryOrder>,
): Promise<boolean> {
  if (current.status !== "at_store" && request.target_status !== "completed") return true;
  const order = await linkedOrder(
    client,
    request.org_id,
    request.store_id,
    current.laundry_order_id,
  );
  if (order === null) return false;
  const garments = await garmentAuthority(
    client,
    request.org_id,
    request.store_id,
    current.laundry_order_id,
  );
  if (request.target_status === "completed") {
    const expected = current.return_method === "delivery" ? "delivered" : "picked_up";
    return (
      order.status === "closed" &&
      order.balance_cents === 0 &&
      garments.length > 0 &&
      garments.every(({ status }) => status === expected || status === "lost")
    );
  }
  return (
    order.status === "open" &&
    atStoreReady(
      garments,
      request.target_status,
      await fulfillmentEnabled(client, request.org_id, request.store_id),
    )
  );
}

async function transitionDeliveryOrder(
  client: SqlClient,
  request: DeliveryOrderTransitionRequest,
): Promise<DeliveryOrderMutationResult> {
  const locked = await loadLocked(
    client,
    request.org_id,
    request.store_id,
    request.delivery_order_id,
  );
  if (locked === null) return Object.freeze({ ok: false, reason: "not_found" });
  const current = mapDeliveryOrder(locked);
  const customerRoots = await client.query<
    Readonly<{ requested_customer_id: string | null; current_customer_id: string | null }>
  >(
    `SELECT customer_canonical_root($1::uuid)::text AS requested_customer_id,
            customer_canonical_root($2::uuid)::text AS current_customer_id`,
    [request.customer_id, current.customer_id],
  );
  if (
    current.version !== request.expected_version ||
    customerRoots.rows[0]?.current_customer_id === null ||
    customerRoots.rows[0]?.requested_customer_id !== customerRoots.rows[0]?.current_customer_id ||
    !canTransitionDeliveryOrder(current.status, request.target_status, {
      collectionMethod: current.collection_method,
      returnMethod: current.return_method,
    }) ||
    !(await transitionAuthority(client, request, current))
  ) {
    return Object.freeze({ ok: false, reason: "state_conflict" });
  }
  const result = await client.query<DeliveryOrderRow>(
    `UPDATE delivery_orders
        SET status = $6, version = version + 1, cancellation_reason = $7,
            completed_at = CASE
              WHEN $6 = 'completed' THEN $8::timestamptz ELSE NULL::timestamptz
            END,
            cancelled_at = CASE
              WHEN $6 = 'cancelled' THEN $8::timestamptz ELSE NULL::timestamptz
            END,
            updated_at = $8::timestamptz, updated_by_staff_id = $9::uuid
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND version = $4 AND status = $5
      RETURNING ${DELIVERY_ORDER_COLUMNS}`,
    [
      request.org_id,
      request.store_id,
      request.delivery_order_id,
      request.expected_version,
      current.status,
      request.target_status,
      request.cancellation_reason,
      new Date(request.at * 1_000),
      request.staff_id,
    ],
  );
  const updated = result.rows[0];
  return updated === undefined
    ? Object.freeze({ ok: false, reason: "state_conflict" })
    : Object.freeze({ ok: true, delivery_order: mapDeliveryOrder(updated), before: current });
}

export function createPgDeliveryOrderStore(pool: PgPool): DeliveryOrderStore {
  return Object.freeze({
    create: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => createDeliveryOrder(client, request),
      ),
    transition: (request) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: request.org_id, storeId: request.store_id, staffId: request.staff_id },
        (client) => transitionDeliveryOrder(client, request),
      ),
    get: (orgId, storeId, deliveryOrderId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<DeliveryOrderRow>(
          `SELECT ${DELIVERY_ORDER_COLUMNS} FROM delivery_orders
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [orgId, storeId, deliveryOrderId],
        );
        return result.rows[0] === undefined ? null : mapDeliveryOrder(result.rows[0]);
      }),
    list: (orgId, storeId, filter) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const query = deliveryOrderListQuery(filter);
        const result = await client.query<DeliveryOrderRow>(query.sql, [
          orgId,
          storeId,
          ...query.values,
        ]);
        return Object.freeze(result.rows.map(mapDeliveryOrder));
      }),
  });
}
