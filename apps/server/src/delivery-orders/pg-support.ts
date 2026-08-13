import type { DeliveryOrder } from "@laundry/contracts";

import { freezeDeliveryOrder } from "./types.js";

export type DeliveryOrderRow = Readonly<{
  delivery_order_id: string;
  laundry_order_id: string;
  customer_id: string;
  collection_method: DeliveryOrder["collection_method"];
  return_method: DeliveryOrder["return_method"];
  pickup_appointment_id: string | null;
  return_appointment_id: string | null;
  pickup_fee_cents: number;
  return_fee_cents: number;
  total_fee_cents: number;
  status: DeliveryOrder["status"];
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  cancellation_reason: DeliveryOrder["cancellation_reason"];
}>;

export const DELIVERY_ORDER_COLUMNS = `id::text AS delivery_order_id,
       laundry_order_id::text, customer_id::text, collection_method, return_method,
       pickup_appointment_id::text, return_appointment_id::text,
       pickup_fee_cents, return_fee_cents, total_fee_cents, status, version,
       created_at, updated_at, completed_at, cancelled_at, cancellation_reason`;

const epoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1_000);

export function mapDeliveryOrder(row: DeliveryOrderRow): DeliveryOrder {
  return freezeDeliveryOrder({
    ...row,
    created_at: epoch(row.created_at),
    updated_at: epoch(row.updated_at),
    completed_at: row.completed_at === null ? null : epoch(row.completed_at),
    cancelled_at: row.cancelled_at === null ? null : epoch(row.cancelled_at),
  });
}
