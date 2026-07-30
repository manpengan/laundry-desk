/**
 * M2 counter handlers: order.receive / order.pickup / order.get / order.list / order.lookup.
 * Optional customer store: transaction-bound upsert on receive when phone present.
 */

import { createCommandError } from "@laundry/contracts";
import { buildPayPayment, lineTotalCents, planPickup, planReceive } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { CustomerStore } from "../customer/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import { listHandler } from "./list-handler.js";
import { lookupHandler } from "./lookup-handler.js";
import {
  assertBusinessDayOpen,
  deriveBusinessDate,
  initialPayment,
  pricingAdjustments,
  requireLines,
  resolveServerPrices,
} from "./server-pricing.js";
import type { GarmentRecord, OrderLineRecord } from "./types.js";

export type { OrderHandlerDeps } from "./deps.js";

/**
 * Customer archival belongs to the same command transaction as order receipt.
 * A failure rolls back the receipt; a PG connection cannot safely continue
 * after a failed statement, and a visible order without its customer record
 * makes customer history inconsistent.
 */
async function upsertCustomerForReceipt(
  customer: CustomerStore,
  phone: string,
  name: string | undefined,
  now: number,
): ReturnType<CustomerStore["upsert"]> {
  return customer.upsert({
    phone,
    ...(name !== undefined ? { name } : {}),
    now,
  });
}

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function formatTicket(dayKey: string, seq: number): string {
  return `${dayKey}-${String(seq).padStart(4, "0")}`;
}

/** Ticket numbers are store-unique; derive a compact customer-facing code without a second counter. */
function formatPickupCode(ticketNo: string): string {
  return `P${ticketNo.replace("-", "")}`;
}

function receiveHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const lines = await resolveServerPrices(deps.catalog, requireLines(input.lines));
    const paymentInput = initialPayment(input);
    const paidCents = paymentInput?.amount_cents ?? 0;
    const plan = planReceive(lines, paidCents, pricingAdjustments(input));
    if (!plan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const newId = deps.newId ?? randomUUID;
    const draftId = typeof input.draft_id === "string" ? input.draft_id : undefined;
    const orderId = draftId ?? newId();
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const dayKey = businessDate.replaceAll("-", "");
    let customerPhone =
      typeof input.customer_phone === "string" && input.customer_phone.length > 0
        ? input.customer_phone
        : null;
    let customerName =
      typeof input.customer_name === "string" && input.customer_name.length > 0
        ? input.customer_name
        : null;

    if (customerPhone !== null && deps.customer !== undefined) {
      const customer = await upsertCustomerForReceipt(
        deps.customer,
        customerPhone,
        customerName ?? undefined,
        now,
      );
      customerPhone = customer.customer.phone;
      customerName = customer.customer.name;
    }

    const seq = await deps.store.nextTicketSeq(ctx.tenant.orgId, ctx.tenant.storeId, dayKey);
    const ticketNo = formatTicket(dayKey, seq);
    const pickupCode = formatPickupCode(ticketNo);

    const orderLines: OrderLineRecord[] = lines.map((line, lineIndex) =>
      Object.freeze({
        line_index: lineIndex,
        service_code: line.service_code,
        category_code: line.category_code,
        unit_price_cents: line.unit_price_cents,
        qty: line.qty,
        line_total_cents: lineTotalCents(line.unit_price_cents, line.qty),
        color: line.color ?? null,
        brand: line.brand ?? null,
      }),
    );

    const garments: GarmentRecord[] = plan.slots.map((slot) => {
      const garmentId = newId();
      return Object.freeze({
        garment_id: garmentId,
        order_id: orderId,
        org_id: ctx.tenant.orgId,
        store_id: ctx.tenant.storeId,
        line_index: slot.line_index,
        seq: slot.seq,
        barcode: garmentId.replace(/-/gu, "").slice(0, 16).toUpperCase(),
        service_code: slot.service_code,
        category_code: slot.category_code,
        unit_price_cents: slot.unit_price_cents,
        color: slot.color,
        brand: slot.brand,
        status: slot.status,
      });
    });

    const order = Object.freeze({
      order_id: orderId,
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      ticket_no: ticketNo,
      pickup_code: pickupCode,
      status: "open" as const,
      customer_phone: customerPhone,
      customer_name: customerName,
      note: typeof input.note === "string" ? input.note : null,
      lines: Object.freeze(orderLines),
      subtotal_cents: plan.totals.subtotal_cents,
      original_cents: plan.totals.original_cents,
      discount_cents: plan.totals.discount_cents,
      addon_cents: plan.totals.addon_cents,
      urgent_cents: plan.totals.urgent_cents,
      freight_cents: plan.totals.freight_cents,
      payable_cents: plan.totals.payable_cents,
      paid_cents: plan.totals.paid_cents,
      balance_cents: plan.totals.balance_cents,
      created_at: now,
      updated_at: now,
      business_date: businessDate,
      created_by_staff_id: ctx.actor.staffId,
    });

    const initialLedger =
      paymentInput === null || paymentInput.amount_cents === 0
        ? undefined
        : Object.freeze({
            payment: buildPayPayment({
              payment_id: newId(),
              org_id: ctx.tenant.orgId,
              store_id: ctx.tenant.storeId,
              order_id: orderId,
              amount_cents: paymentInput.amount_cents,
              staff_id: ctx.actor.staffId,
              at: now,
              method: paymentInput.method,
              note: paymentInput.note ?? null,
            }),
            business_date: businessDate,
          });
    if (draftId === undefined || deps.store.replaceDraft === undefined) {
      await deps.store.insertOrder(order, garments, initialLedger);
    } else if (!(await deps.store.replaceDraft(order, garments, initialLedger))) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    return Object.freeze({
      result: Object.freeze({
        order_id: order.order_id,
        ticket_no: order.ticket_no,
        pickup_code: order.pickup_code,
        payable_cents: order.payable_cents,
        paid_cents: order.paid_cents,
        balance_cents: order.balance_cents,
        garment_count: garments.length,
        garments: Object.freeze(
          garments.map((g) =>
            Object.freeze({
              garment_id: g.garment_id,
              barcode: g.barcode,
              status: g.status,
              line_index: g.line_index,
              seq: g.seq,
            }),
          ),
        ),
      }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({
          ticket_no: order.ticket_no,
          pickup_code: order.pickup_code,
          payable_cents: order.payable_cents,
          garment_count: garments.length,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "order.created",
          payload: Object.freeze({ order_id: order.order_id, ticket_no: order.ticket_no }),
        }),
      ]),
    });
  };
}

function pickupHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
    const collectCents = requireNumber(input.collect_cents);
    const garmentIdsRaw = input.garment_ids;
    if (!Array.isArray(garmentIdsRaw)) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const selectedIds = garmentIdsRaw.map((id) => requireString(id));

    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const garments = await deps.store.listGarments(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order.status !== "open") {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const plan = planPickup({
      garments: garments.map((g) => Object.freeze({ garment_id: g.garment_id, status: g.status })),
      selected_garment_ids: selectedIds,
      balance_cents: order.balance_cents,
      collect_cents: collectCents,
      order_status: "open",
      fulfillment_enabled: true,
    });
    if (!plan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const applied = await deps.store.applyPickup(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      orderId,
      plan.garment_ids,
      plan.collect_cents,
      now,
      Object.freeze({
        staffId: ctx.actor.staffId,
        method: "cash" as const,
        businessDate,
        nextOrderStatus: plan.next_order_status,
        nextBalanceCents: plan.next_balance_cents,
      }),
    );
    if (applied === null) {
      throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
    }

    return Object.freeze({
      result: Object.freeze({
        order_id: applied.order.order_id,
        ticket_no: applied.order.ticket_no,
        status: applied.order.status,
        paid_cents: applied.order.paid_cents,
        balance_cents: applied.order.balance_cents,
        picked_garment_ids: plan.garment_ids,
      }),
      audit: Object.freeze({
        entity: "order",
        entityId: applied.order.order_id,
        afterJson: JSON.stringify({
          picked: plan.garment_ids.length,
          collect_cents: plan.collect_cents,
          balance_cents: applied.order.balance_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "garment.picked_up",
          payload: Object.freeze({
            order_id: applied.order.order_id,
            garment_ids: plan.garment_ids,
          }),
        }),
      ]),
    });
  };
}

function getHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
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
          garments.map((g) =>
            Object.freeze({
              garment_id: g.garment_id,
              barcode: g.barcode,
              status: g.status,
              line_index: g.line_index,
              seq: g.seq,
              unit_price_cents: g.unit_price_cents,
            }),
          ),
        ),
      }),
    });
  };
}

export function createOrderHandlers(
  deps: OrderHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "order.receive": receiveHandler(deps),
    "order.pickup": pickupHandler(deps),
  });
}

export function createOrderQueryHandlers(
  deps: OrderHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "order.get": getHandler(deps),
    "order.list": listHandler(deps),
    "order.lookup": lookupHandler(deps),
  });
}

export function registerOrderCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: OrderHandlerDeps,
): void {
  const handlers = createOrderHandlers(deps);
  registry.registerHandler("order.receive", handlers["order.receive"]!);
  registry.registerHandler("order.pickup", handlers["order.pickup"]!);
}

export function registerOrderQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: OrderHandlerDeps,
): void {
  const handlers = createOrderQueryHandlers(deps);
  registry.registerHandler("order.get", handlers["order.get"]!);
  registry.registerHandler("order.list", handlers["order.list"]!);
  registry.registerHandler("order.lookup", handlers["order.lookup"]!);
}
