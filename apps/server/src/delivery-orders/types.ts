import {
  DeliveryOrderSchema,
  type DeliveryOrder,
  type DeliveryOrderCancellationReason,
  type DeliveryOrderStatus,
  type DeliveryOrdersListInput,
} from "@laundry/contracts";

export type DeliveryOrderCreateRequest = Readonly<{
  delivery_order_id: string;
  customer_id: string;
  org_id: string;
  store_id: string;
  staff_id: string;
  laundry_order_id: string;
  collection_method: DeliveryOrder["collection_method"];
  return_method: DeliveryOrder["return_method"];
  pickup_appointment_id: string | null;
  return_appointment_id: string | null;
  at: number;
}>;

export type DeliveryOrderTransitionRequest = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  delivery_order_id: string;
  customer_id: string;
  expected_version: number;
  target_status: DeliveryOrderStatus;
  cancellation_reason: DeliveryOrderCancellationReason | null;
  at: number;
}>;

export type DeliveryOrderMutationFailure =
  "duplicate" | "feature_disabled" | "link_invalid" | "not_found" | "state_conflict";

export type DeliveryOrderMutationResult =
  | Readonly<{
      ok: true;
      delivery_order: DeliveryOrder;
      before: DeliveryOrder | null;
    }>
  | Readonly<{ ok: false; reason: DeliveryOrderMutationFailure }>;

export type DeliveryOrderListFilter = Readonly<
  Omit<DeliveryOrdersListInput, "limit"> & { limit: number }
>;

export type DeliveryOrderStore = Readonly<{
  create: (request: DeliveryOrderCreateRequest) => Promise<DeliveryOrderMutationResult>;
  transition: (request: DeliveryOrderTransitionRequest) => Promise<DeliveryOrderMutationResult>;
  get: (orgId: string, storeId: string, deliveryOrderId: string) => Promise<DeliveryOrder | null>;
  list: (
    orgId: string,
    storeId: string,
    filter: DeliveryOrderListFilter,
  ) => Promise<readonly DeliveryOrder[]>;
}>;

export function freezeDeliveryOrder(input: DeliveryOrder): DeliveryOrder {
  const parsed = DeliveryOrderSchema.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid delivery order");
  const row = parsed.data;
  if (row.total_fee_cents !== row.pickup_fee_cents + row.return_fee_cents) {
    throw new TypeError("Invalid delivery fee total");
  }
  const completed = row.status === "completed";
  const cancelled = row.status === "cancelled";
  if (
    completed !== (row.completed_at !== null) ||
    cancelled !== (row.cancelled_at !== null) ||
    cancelled !== (row.cancellation_reason !== null)
  ) {
    throw new TypeError("Invalid delivery order terminal state");
  }
  return Object.freeze({ ...row });
}

export type DeliveryOrderDerivedCreate = Readonly<{
  customer_id: string;
  pickup_fee_cents: number;
  return_fee_cents: number;
  status: DeliveryOrderStatus;
}>;

export function createdDeliveryOrder(
  request: DeliveryOrderCreateRequest,
  derived: DeliveryOrderDerivedCreate,
): DeliveryOrder {
  return freezeDeliveryOrder({
    delivery_order_id: request.delivery_order_id,
    laundry_order_id: request.laundry_order_id,
    customer_id: derived.customer_id,
    collection_method: request.collection_method,
    return_method: request.return_method,
    pickup_appointment_id: request.pickup_appointment_id,
    return_appointment_id: request.return_appointment_id,
    pickup_fee_cents: derived.pickup_fee_cents,
    return_fee_cents: derived.return_fee_cents,
    total_fee_cents: derived.pickup_fee_cents + derived.return_fee_cents,
    status: derived.status,
    version: 1,
    created_at: request.at,
    updated_at: request.at,
    completed_at: null,
    cancelled_at: null,
    cancellation_reason: null,
  });
}
