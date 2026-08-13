import { randomUUID } from "node:crypto";

import {
  DeliveryOrderCreateInputSchema,
  DeliveryOrderGetInputSchema,
  DeliveryOrderGetResultSchema,
  DeliveryOrderMutationResultSchema,
  DeliveryOrderTransitionInputSchema,
  DeliveryOrdersListInputSchema,
  DeliveryOrdersListResultSchema,
  createCommandError,
  type DeliveryOrder,
} from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { DeliveryOrderStore } from "./types.js";

export type DeliveryOrderHandlerDeps = Readonly<{
  store: DeliveryOrderStore;
  now?: () => number;
  newId?: () => string;
}>;

function invariantFailed(): never {
  throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
}

function unavailable(): never {
  throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

function auditView(row: DeliveryOrder): Readonly<Record<string, unknown>> {
  return Object.freeze({
    delivery_order_id: row.delivery_order_id,
    laundry_order_id: row.laundry_order_id,
    collection_method: row.collection_method,
    return_method: row.return_method,
    pickup_appointment_id: row.pickup_appointment_id,
    return_appointment_id: row.return_appointment_id,
    pickup_fee_cents: row.pickup_fee_cents,
    return_fee_cents: row.return_fee_cents,
    total_fee_cents: row.total_fee_cents,
    status: row.status,
    version: row.version,
    cancellation_reason: row.cancellation_reason,
  });
}

function mutationOutcome(
  deliveryOrder: DeliveryOrder,
  before: DeliveryOrder | null,
  eventType: string,
): HandlerOutcome {
  return Object.freeze({
    result: DeliveryOrderMutationResultSchema.parse({ delivery_order: deliveryOrder }),
    privacySubjectCustomerId: deliveryOrder.customer_id,
    audit: Object.freeze({
      entity: "delivery_order",
      entityId: deliveryOrder.delivery_order_id,
      ...(before === null ? {} : { beforeJson: JSON.stringify(auditView(before)) }),
      afterJson: JSON.stringify(auditView(deliveryOrder)),
    }),
    events: Object.freeze([
      Object.freeze({
        type: eventType,
        payload: Object.freeze({
          delivery_order_id: deliveryOrder.delivery_order_id,
          laundry_order_id: deliveryOrder.laundry_order_id,
          customer_id: deliveryOrder.customer_id,
          status: deliveryOrder.status,
          version: deliveryOrder.version,
        }),
      }),
    ]),
  });
}

function createHandler(deps: DeliveryOrderHandlerDeps): CommandHandler {
  return async (context) => {
    const input = DeliveryOrderCreateInputSchema.parse(context.parsed);
    const result = await deps.store.create({
      delivery_order_id: deps.newId?.() ?? randomUUID(),
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      laundry_order_id: input.laundry_order_id,
      customer_id: input.customer_id,
      collection_method: input.collection_method,
      return_method: input.return_method,
      pickup_appointment_id: input.pickup_appointment_id ?? null,
      return_appointment_id: input.return_appointment_id ?? null,
      at: deps.now?.() ?? Math.floor(Date.now() / 1_000),
    });
    if (!result.ok) invariantFailed();
    return mutationOutcome(result.delivery_order, null, "delivery.order.created");
  };
}

function transitionHandler(deps: DeliveryOrderHandlerDeps): CommandHandler {
  return async (context) => {
    const input = DeliveryOrderTransitionInputSchema.parse(context.parsed);
    const result = await deps.store.transition({
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      delivery_order_id: input.delivery_order_id,
      customer_id: input.customer_id,
      expected_version: input.expected_version,
      target_status: input.target_status,
      cancellation_reason: input.cancellation_reason ?? null,
      at: deps.now?.() ?? Math.floor(Date.now() / 1_000),
    });
    if (!result.ok) invariantFailed();
    return mutationOutcome(
      result.delivery_order,
      result.before,
      result.delivery_order.status === "cancelled"
        ? "delivery.order.cancelled"
        : result.delivery_order.status === "completed"
          ? "delivery.order.completed"
          : "delivery.order.transitioned",
    );
  };
}

export function registerDeliveryOrderCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryOrderHandlerDeps,
): void {
  registry.registerHandler("delivery.order.create", createHandler(deps));
  registry.registerHandler("delivery.order.transition", transitionHandler(deps));
}

export function registerDeliveryOrderQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryOrderHandlerDeps,
): void {
  registry.registerHandler("delivery.order.get", async (context) => {
    const input = DeliveryOrderGetInputSchema.parse(context.parsed);
    const deliveryOrder = await deps.store.get(
      context.tenant.orgId,
      context.tenant.storeId,
      input.delivery_order_id,
    );
    if (deliveryOrder === null) unavailable();
    return Object.freeze({
      result: DeliveryOrderGetResultSchema.parse({ delivery_order: deliveryOrder }),
    });
  });
  registry.registerHandler("delivery.orders.list", async (context) => {
    const parsed = DeliveryOrdersListInputSchema.parse(context.parsed);
    const deliveryOrders = await deps.store.list(
      context.tenant.orgId,
      context.tenant.storeId,
      Object.freeze({ ...parsed, limit: parsed.limit ?? 50 }),
    );
    return Object.freeze({
      result: DeliveryOrdersListResultSchema.parse({ delivery_orders: deliveryOrders }),
    });
  });
}
