import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import type { GarmentDetailRecord, GarmentRecord, OrderLineRecord } from "./types.js";

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

const EMPTY_DETAILS: GarmentDetailRecord = Object.freeze({
  color: null,
  brand: null,
  defects: Object.freeze([]),
  accessories: Object.freeze([]),
  note: null,
  addons: Object.freeze([]),
});

function detailResult(detail: GarmentDetailRecord) {
  return Object.freeze({
    color: detail.color,
    brand: detail.brand,
    defects: Object.freeze([...detail.defects]),
    accessories: Object.freeze([...detail.accessories]),
    note: detail.note,
    addons: Object.freeze(detail.addons.map((addon) => Object.freeze({ ...addon }))),
  });
}

function lineResult(line: OrderLineRecord) {
  return Object.freeze({
    line_index: line.line_index,
    service_code: line.service_code,
    category_code: line.category_code,
    unit_price_cents: line.unit_price_cents,
    qty: line.qty,
    line_total_cents: line.line_total_cents,
    color: line.color,
    brand: line.brand,
    garments: Object.freeze(
      Array.from({ length: line.qty }, (_, index) => {
        const detail =
          line.garment_details?.[index] ??
          Object.freeze({ ...EMPTY_DETAILS, color: line.color, brand: line.brand });
        return detailResult(detail);
      }),
    ),
  });
}

function garmentResult(garment: GarmentRecord, lines: readonly OrderLineRecord[]) {
  const line = lines.find((candidate) => candidate.line_index === garment.line_index);
  const detail = line?.garment_details?.[garment.seq - 1];
  return Object.freeze({
    garment_id: garment.garment_id,
    barcode: garment.barcode,
    status: garment.status,
    line_index: garment.line_index,
    seq: garment.seq,
    service_code: garment.service_code,
    category_code: garment.category_code,
    unit_price_cents: garment.unit_price_cents,
    color: garment.color,
    brand: garment.brand,
    defects: Object.freeze([...(garment.defects ?? [])]),
    accessories: Object.freeze([...(garment.accessories ?? [])]),
    note: garment.note ?? null,
    addons: Object.freeze((detail?.addons ?? []).map((addon) => Object.freeze({ ...addon }))),
    rack_zone: garment.rack_zone ?? null,
    rack_slot: garment.rack_slot ?? null,
  });
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
        // Needed so the counter can offer stored-value settlement without a
        // second lookup: the phone here is masked and cannot identify a
        // customer reliably (ADR-17).
        customer_id: order.customer_id,
        customer_phone: order.customer_phone,
        customer_name: order.customer_name,
        note: order.note,
        subtotal_cents: order.subtotal_cents,
        original_cents: order.original_cents,
        discount_cents: order.discount_cents,
        addon_cents: order.addon_cents,
        urgent_cents: order.urgent_cents,
        freight_cents: order.freight_cents,
        pricing_policy_version: order.pricing_policy_version ?? 0,
        urgent_selected: order.urgent_selected ?? false,
        freight_selected: order.freight_selected ?? false,
        payable_cents: order.payable_cents,
        paid_cents: order.paid_cents,
        balance_cents: order.balance_cents,
        lines: Object.freeze(order.lines.map(lineResult)),
        garments: Object.freeze(garments.map((garment) => garmentResult(garment, order.lines))),
      }),
    });
  };
}
