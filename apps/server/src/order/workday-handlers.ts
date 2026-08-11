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
  requireLines,
  requireString,
  resolveServerPrices,
  resolveTrustedPricing,
} from "./server-pricing.js";
import type { OrderLineRecord, OrderRecord } from "./types.js";

function holdHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    if (deps.store.replaceDraft === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = asRecord(ctx.parsed);
    const catalogLines = await resolveServerPrices(deps.catalog, requireLines(input.lines));
    const policy = await deps.pricing?.get(ctx.tenant.orgId, ctx.tenant.storeId);
    const trustedPricing = resolveTrustedPricing(
      input,
      catalogLines,
      policy,
      ctx.actor.permissions,
    );
    const lines = trustedPricing.lines;
    const plan = planReceive(lines, 0, trustedPricing.adjustments);
    if (!plan.ok) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await deps.lockBusinessDay?.(ctx.client, ctx.tenant, businessDate);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const newId = deps.newId ?? randomUUID;
    const draftId = typeof input.draft_id === "string" ? input.draft_id : newId();
    let phone = typeof input.customer_phone === "string" ? input.customer_phone : null;
    let name = typeof input.customer_name === "string" ? input.customer_name : null;
    let customerId: string | null = null;
    if (phone !== null && deps.customer !== undefined) {
      const customer = await deps.customer.upsert({
        phone,
        ...(name !== null ? { name } : {}),
        now,
      });
      customerId = customer.customer.customer_id;
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
          garment_details: line.garment_details,
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
      customer_id: customerId,
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
      pricing_policy_version: trustedPricing.pricing_policy_version,
      urgent_selected: trustedPricing.urgent_selected,
      freight_selected: trustedPricing.freight_selected,
      payable_cents: plan.totals.payable_cents,
      paid_cents: 0,
      balance_cents: plan.totals.payable_cents,
      created_at: now,
      updated_at: now,
      business_date: businessDate,
      created_by_staff_id: ctx.actor.staffId,
    });
    if (
      !(await deps.store.replaceDraft(order, Object.freeze([]), undefined, {
        requireExisting: input.draft_id !== undefined,
      }))
    ) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result: Object.freeze({ draft_id: order.order_id, payable_cents: order.payable_cents }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({
          status: order.status,
          payable_cents: order.payable_cents,
          pricing_policy_version: order.pricing_policy_version,
          discount_cents: order.discount_cents,
          addon_cents: order.addon_cents,
          urgent_cents: order.urgent_cents,
          freight_cents: order.freight_cents,
        }),
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
    await deps.lockBusinessDay?.(ctx.client, ctx.tenant, businessDate);
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
