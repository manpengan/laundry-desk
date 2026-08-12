import { createCommandError } from "@laundry/contracts";
import { planPickup } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import { parseVerificationBarcodes, requireVerifiedRackBarcodes } from "./pickup-verification.js";
import { assertBusinessDayOpen, deriveBusinessDate } from "./server-pricing.js";

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

export function pickupHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
    const collectCents = requireNumber(input.collect_cents);
    const garmentIdsRaw = input.garment_ids;
    if (!Array.isArray(garmentIdsRaw)) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const selectedIds = garmentIdsRaw.map((id) => requireString(id));
    const verificationBarcodes = parseVerificationBarcodes(input.verification_barcodes);

    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const garments = await deps.store.listGarments(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order.status !== "open") {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const plan = planPickup({
      garments: garments.map((garment) =>
        Object.freeze({ garment_id: garment.garment_id, status: garment.status }),
      ),
      selected_garment_ids: selectedIds,
      balance_cents: order.balance_cents,
      collect_cents: collectCents,
      order_status: "open",
      fulfillment_enabled: true,
    });
    if (!plan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const requiredBarcodes = requireVerifiedRackBarcodes(
      garments,
      plan.garment_ids,
      verificationBarcodes,
    );

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await deps.lockBusinessDay?.(ctx.client, ctx.tenant, businessDate);
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
        verificationBarcodes,
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
          verified_racked_count: requiredBarcodes.length,
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
