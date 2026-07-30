import { createCommandError } from "@laundry/contracts";
import { lineTotalCents, planReceive } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import {
  assertBusinessDayOpen,
  asRecord,
  deriveBusinessDate,
  pricingAdjustments,
  requireLines,
  requireString,
  resolveServerPrices,
} from "./server-pricing.js";
import type { OrderLineRecord, OrderRecord } from "./types.js";

function holdHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    if (deps.store.replaceDraft === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = asRecord(ctx.parsed);
    const lines = await resolveServerPrices(deps.catalog, requireLines(input.lines));
    const plan = planReceive(lines, 0, pricingAdjustments(input));
    if (!plan.ok) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const newId = deps.newId ?? randomUUID;
    const draftId = typeof input.draft_id === "string" ? input.draft_id : newId();
    let phone = typeof input.customer_phone === "string" ? input.customer_phone : null;
    let name = typeof input.customer_name === "string" ? input.customer_name : null;
    if (phone !== null && deps.customer !== undefined) {
      const customer = await deps.customer.upsert({
        phone,
        ...(name !== null ? { name } : {}),
        now,
      });
      phone = customer.customer.phone;
      name = customer.customer.name;
    }
    const orderLines: readonly OrderLineRecord[] = Object.freeze(
      lines.map((line, lineIndex) =>
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
      ),
    );
    const order: OrderRecord = Object.freeze({
      order_id: draftId,
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      ticket_no: null,
      pickup_code: null,
      status: "draft",
      customer_phone: phone,
      customer_name: name,
      note: typeof input.note === "string" ? input.note : null,
      lines: orderLines,
      subtotal_cents: plan.totals.subtotal_cents,
      original_cents: plan.totals.original_cents,
      discount_cents: plan.totals.discount_cents,
      addon_cents: plan.totals.addon_cents,
      urgent_cents: plan.totals.urgent_cents,
      freight_cents: plan.totals.freight_cents,
      payable_cents: plan.totals.payable_cents,
      paid_cents: 0,
      balance_cents: plan.totals.payable_cents,
      created_at: now,
      updated_at: now,
      business_date: businessDate,
      created_by_staff_id: ctx.actor.staffId,
    });
    if (!(await deps.store.replaceDraft(order, Object.freeze([])))) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result: Object.freeze({ draft_id: order.order_id, payable_cents: order.payable_cents }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({ status: order.status, payable_cents: order.payable_cents }),
      }),
      events: Object.freeze([
        Object.freeze({ type: "order.held", payload: Object.freeze({ draft_id: order.order_id }) }),
      ]),
    });
  };
}

function cancelHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    if (deps.store.cancelOpenOrder === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
    const reason = requireString(input.reason).trim();
    if (reason.length === 0) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const order = await deps.store.cancelOpenOrder(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      orderId,
      reason,
      ctx.actor.staffId,
      now,
      businessDate,
    );
    if (order === null) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    return Object.freeze({
      result: Object.freeze({ order_id: order.order_id, status: order.status }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({ status: order.status, reason }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "order.cancelled",
          payload: Object.freeze({ order_id: order.order_id }),
        }),
      ]),
    });
  };
}

export function registerOrderWorkdayCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: OrderHandlerDeps,
): void {
  registry.registerHandler("order.hold", holdHandler(deps));
  registry.registerHandler("order.cancel", cancelHandler(deps));
}
