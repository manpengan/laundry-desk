import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";

function orderIdFromParsed(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  const orderId = (parsed as Readonly<Record<string, unknown>>).order_id;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return orderId;
}

export function getHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const orderId = orderIdFromParsed(ctx.parsed);
    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const garments = await deps.store.listGarments(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    return Object.freeze({
      result: Object.freeze({
        order_id: order.order_id,
        ticket_no: order.ticket_no,
        pickup_code: order.pickup_code,
        status: order.status,
        customer_phone: order.customer_phone,
        customer_name: order.customer_name,
        payable_cents: order.payable_cents,
        paid_cents: order.paid_cents,
        balance_cents: order.balance_cents,
        garments: Object.freeze(
          garments.map((garment) =>
            Object.freeze({
              garment_id: garment.garment_id,
              barcode: garment.barcode,
              status: garment.status,
              line_index: garment.line_index,
              seq: garment.seq,
              unit_price_cents: garment.unit_price_cents,
              rack_zone: garment.rack_zone ?? null,
              rack_slot: garment.rack_slot ?? null,
            }),
          ),
        ),
      }),
    });
  };
}
