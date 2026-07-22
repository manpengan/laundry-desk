/**
 * M2 skeleton handlers: order.receive / order.pickup (async OrderStore).
 */

import { createCommandError } from "@laundry/contracts";
import { lineTotalCents, planPickup, planReceive } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { GarmentRecord, OrderLineRecord, OrderStore } from "./types.js";

export type OrderHandlerDeps = Readonly<{
  store: OrderStore;
  now?: () => number;
  newId?: () => string;
}>;

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

function dayKeyFromEpoch(epoch: number): string {
  const d = new Date(epoch * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function formatTicket(dayKey: string, seq: number): string {
  return `${dayKey}-${String(seq).padStart(4, "0")}`;
}

function receiveHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const linesRaw = input.lines;
    if (!Array.isArray(linesRaw) || linesRaw.length === 0) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const lines = linesRaw.map((row) => {
      const r = asRecord(row);
      return Object.freeze({
        service_code: requireString(r.service_code),
        category_code: requireString(r.category_code),
        unit_price_cents: requireNumber(r.unit_price_cents),
        qty: requireNumber(r.qty),
        ...(typeof r.color === "string" ? { color: r.color } : {}),
        ...(typeof r.brand === "string" ? { brand: r.brand } : {}),
      });
    });
    const paidCents = requireNumber(input.paid_cents);
    const plan = planReceive(lines, paidCents);
    if (!plan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const newId = deps.newId ?? randomUUID;
    const orderId = newId();
    const dayKey = dayKeyFromEpoch(now);
    const seq = await deps.store.nextTicketSeq(ctx.tenant.orgId, ctx.tenant.storeId, dayKey);
    const ticketNo = formatTicket(dayKey, seq);

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
      status: "open" as const,
      customer_phone: typeof input.customer_phone === "string" ? input.customer_phone : null,
      customer_name: typeof input.customer_name === "string" ? input.customer_name : null,
      note: typeof input.note === "string" ? input.note : null,
      lines: Object.freeze(orderLines),
      subtotal_cents: plan.totals.subtotal_cents,
      payable_cents: plan.totals.payable_cents,
      paid_cents: plan.totals.paid_cents,
      balance_cents: plan.totals.balance_cents,
      created_at: now,
      updated_at: now,
      created_by_staff_id: ctx.actor.staffId,
    });

    await deps.store.insertOrder(order, garments);

    return Object.freeze({
      result: Object.freeze({
        order_id: order.order_id,
        ticket_no: order.ticket_no,
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
    const plan = planPickup({
      garments: garments.map((g) => Object.freeze({ garment_id: g.garment_id, status: g.status })),
      selected_garment_ids: selectedIds,
      balance_cents: order.balance_cents,
      collect_cents: collectCents,
      fulfillment_enabled: false,
    });
    if (!plan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const applied = await deps.store.applyPickup(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      orderId,
      plan.garment_ids,
      plan.collect_cents,
      now,
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

export function createOrderHandlers(
  deps: OrderHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "order.receive": receiveHandler(deps),
    "order.pickup": pickupHandler(deps),
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
