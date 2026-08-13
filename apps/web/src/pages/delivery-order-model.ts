import {
  DeliveryOrderGetResultSchema,
  DeliveryOrderMutationResultSchema,
  DeliveryOrderTransitionInputSchema,
  DeliveryOrdersListInputSchema,
  DeliveryOrdersListResultSchema,
  type DeliveryOrder,
  type DeliveryOrderCancellationReason,
  type DeliveryOrderStatus,
  type DeliveryOrderTransitionInput,
  type DeliveryOrdersListInput,
} from "@laundry/contracts";
import { validDeliveryOrderTransitions } from "@laundry/domain";

export type DeliveryOrderView = Readonly<DeliveryOrder>;
export type DeliveryOrderPendingTransition = Readonly<{
  body: DeliveryOrderTransitionInput;
  authorityKey: string;
  confirmRef: string;
  kind: "confirm" | "step_up";
  label: string;
  summary: Readonly<{
    deliveryOrderId: string;
    laundryOrderId: string;
    currentStatus: DeliveryOrderStatus;
    collectionMethod: DeliveryOrder["collection_method"];
    returnMethod: DeliveryOrder["return_method"];
    cancellationReason: DeliveryOrderCancellationReason | null;
  }>;
}>;

export const DELIVERY_ORDER_STATUS_LABELS: Readonly<Record<DeliveryOrderStatus, string>> =
  Object.freeze({
    pickup_scheduled: "待上门取件",
    pickup_in_progress: "取件途中",
    picked_up: "已取到衣物",
    at_store: "衣物在店",
    return_scheduled: "待送回",
    return_in_progress: "送回途中",
    self_pickup_ready: "待顾客自取",
    completed: "已完成",
    cancelled: "已取消",
  });

export const DELIVERY_ORDER_CANCELLATION_LABELS: Readonly<
  Record<DeliveryOrderCancellationReason, string>
> = Object.freeze({
  customer_request: "顾客要求取消",
  store_request: "门店要求取消",
  appointment_cancelled: "预约已取消",
  duplicate: "重复创建",
  other: "其他受控原因",
});

export const DELIVERY_ORDER_ROUTE_LABELS = Object.freeze({
  collection: Object.freeze({ pickup: "上门取件", store_dropoff: "到店送洗" }),
  return: Object.freeze({ delivery: "送回到家", self_pickup: "顾客自取" }),
});

export const DELIVERY_ORDER_STATUS_FILTERS: readonly (DeliveryOrderStatus | "all")[] =
  Object.freeze([
    "all",
    "pickup_scheduled",
    "pickup_in_progress",
    "picked_up",
    "at_store",
    "return_scheduled",
    "return_in_progress",
    "self_pickup_ready",
    "completed",
    "cancelled",
  ]);

export function shortDeliveryOrderId(value: string): string {
  return value.slice(0, 8);
}

function unwrapBusResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const result = value as Readonly<Record<string, unknown>>;
  return "result" in result ? result.result : value;
}

export function parseDeliveryOrders(value: unknown): readonly DeliveryOrderView[] | null {
  const parsed = DeliveryOrdersListResultSchema.safeParse(unwrapBusResult(value));
  return parsed.success
    ? Object.freeze(parsed.data.delivery_orders.map((row) => Object.freeze({ ...row })))
    : null;
}

export function parseDeliveryOrder(value: unknown): DeliveryOrderView | null {
  const parsed = DeliveryOrderGetResultSchema.safeParse(unwrapBusResult(value));
  return parsed.success ? Object.freeze({ ...parsed.data.delivery_order }) : null;
}

export function parseDeliveryOrderMutation(value: unknown): DeliveryOrderView | null {
  const parsed = DeliveryOrderMutationResultSchema.safeParse(unwrapBusResult(value));
  return parsed.success ? Object.freeze({ ...parsed.data.delivery_order }) : null;
}

export function buildDeliveryOrderListInput(
  status: DeliveryOrderStatus | null,
): DeliveryOrdersListInput | null {
  const parsed = DeliveryOrdersListInputSchema.safeParse({
    ...(status === null ? {} : { status }),
    limit: 100,
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function buildDeliveryOrderTransition(
  order: DeliveryOrderView,
  targetStatus: DeliveryOrderStatus,
  cancellationReason: DeliveryOrderCancellationReason = "customer_request",
): DeliveryOrderTransitionInput | null {
  if (!nextDeliveryOrderStatuses(order).includes(targetStatus)) return null;
  const parsed = DeliveryOrderTransitionInputSchema.safeParse({
    delivery_order_id: order.delivery_order_id,
    customer_id: order.customer_id,
    expected_version: order.version,
    target_status: targetStatus,
    ...(targetStatus === "cancelled" ? { cancellation_reason: cancellationReason } : {}),
  });
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function nextDeliveryOrderStatuses(
  order: DeliveryOrderView,
): readonly DeliveryOrderStatus[] {
  return validDeliveryOrderTransitions(order.status, {
    collectionMethod: order.collection_method,
    returnMethod: order.return_method,
  });
}

export function formatDeliveryOrderFee(feeCents: number): string {
  return `¥${(feeCents / 100).toFixed(2)}`;
}

export function formatDeliveryOrderTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1_000));
}
