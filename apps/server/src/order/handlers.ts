/**
 * M2 counter handlers: order.receive / order.pickup / order.get / order.list / order.lookup.
 * Optional customer store: transaction-bound upsert on receive when phone present.
 */

import { createCommandError } from "@laundry/contracts";
import { buildPayPayment, lineTotalCents, planReceive } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import { getHandler } from "./get-handler.js";
import { listHandler } from "./list-handler.js";
import { lookupHandler } from "./lookup-handler.js";
import { pickupHandler } from "./pickup-handler.js";
import { formatPickupCode, formatTicket, upsertCustomerForReceipt } from "./receipt-helpers.js";
import {
  assertBusinessDayOpen,
  assertReplayCustomerPolicy,
  deriveBusinessDate,
  initialPayment,
  requireLines,
  resolveServerPrices,
  resolveCustomerPolicyPricing,
  resolveTrustedPricing,
} from "./server-pricing.js";
import type { GarmentRecord, OrderLineRecord } from "./types.js";

export type { OrderHandlerDeps } from "./deps.js";

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function receiveHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
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
    const paymentInput = initialPayment(input);
    const paidCents = paymentInput?.amount_cents ?? 0;
    const initialPlan = planReceive(lines, paidCents, trustedPricing.adjustments);
    if (!initialPlan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }

    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const newId = deps.newId ?? randomUUID;
    const draftId = typeof input.draft_id === "string" ? input.draft_id : undefined;
    const orderId = draftId ?? newId();
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await deps.lockBusinessDay?.(ctx.client, ctx.tenant, businessDate);
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
    let customerId: string | null = null;

    if (customerPhone !== null && deps.customer !== undefined) {
      const customer = await upsertCustomerForReceipt(
        deps.customer,
        customerPhone,
        customerName ?? undefined,
        now,
      );
      customerId = customer.customer.customer_id;
      customerPhone = customer.customer.phone;
      customerName = customer.customer.name;
    }

    const customerPolicy =
      customerId === null || deps.customerPolicy === undefined
        ? null
        : await deps.customerPolicy(ctx.client, ctx.tenant, customerId, businessDate);
    assertReplayCustomerPolicy(ctx.actor.via, customerPolicy);
    const appliedPricing = resolveCustomerPolicyPricing(trustedPricing, customerPolicy);
    const plan = planReceive(lines, paidCents, appliedPricing.adjustments);
    if (!plan.ok) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
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
        garment_details: line.garment_details,
      }),
    );

    const garments: GarmentRecord[] = plan.slots.map((slot) => {
      const garmentId = newId();
      const detail = lines[slot.line_index]?.garment_details[slot.seq - 1];
      if (detail === undefined) {
        throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
      }
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
        color: detail.color,
        brand: detail.brand,
        defects: detail.defects,
        accessories: detail.accessories,
        note: detail.note,
        status: slot.status,
        rack_zone: null,
        rack_slot: null,
      });
    });

    const order = Object.freeze({
      order_id: orderId,
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      ticket_no: ticketNo,
      pickup_code: pickupCode,
      status: "open" as const,
      customer_id: customerId,
      customer_phone: customerPhone,
      customer_name: customerName,
      note: typeof input.note === "string" ? input.note : null,
      lines: Object.freeze(orderLines),
      subtotal_cents: plan.totals.subtotal_cents,
      original_cents: plan.totals.original_cents,
      discount_cents: plan.totals.discount_cents,
      customer_profile_version: customerPolicy?.customer_profile_version ?? 0,
      discount_source: appliedPricing.discount_source,
      discount_bps: appliedPricing.discount_bps,
      membership_version: customerPolicy?.membership_version ?? null,
      tier_id: customerPolicy?.tier?.tier_id ?? null,
      tier_definition_version: customerPolicy?.tier?.definition_version ?? null,
      tier_code: customerPolicy?.tier?.code ?? null,
      tier_name: customerPolicy?.tier?.name ?? null,
      tier_level: customerPolicy?.tier?.level ?? null,
      tier_discount_bps: customerPolicy?.tier?.discount_bps ?? null,
      skip_ticket_print: customerPolicy?.waivers.skip_ticket_print ?? false,
      skip_label_print: customerPolicy?.waivers.skip_label_print ?? false,
      skip_rack_assignment: customerPolicy?.waivers.skip_rack_assignment ?? false,
      addon_cents: plan.totals.addon_cents,
      urgent_cents: plan.totals.urgent_cents,
      freight_cents: plan.totals.freight_cents,
      pricing_policy_version: trustedPricing.pricing_policy_version,
      urgent_selected: trustedPricing.urgent_selected,
      freight_selected: trustedPricing.freight_selected,
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
    } else if (
      !(await deps.store.replaceDraft(order, garments, initialLedger, {
        requireExisting: true,
      }))
    ) {
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
        discount_cents: order.discount_cents,
        discount_source: order.discount_source,
        discount_bps: order.discount_bps,
        waivers: Object.freeze({
          skip_ticket_print: order.skip_ticket_print,
          skip_label_print: order.skip_label_print,
          skip_rack_assignment: order.skip_rack_assignment,
        }),
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
      ...(customerId === null ? {} : { privacySubjectCustomerId: customerId }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({
          ticket_no: order.ticket_no,
          pickup_code: order.pickup_code,
          payable_cents: order.payable_cents,
          pricing_policy_version: order.pricing_policy_version,
          discount_cents: order.discount_cents,
          discount_source: order.discount_source,
          discount_bps: order.discount_bps,
          customer_profile_version: order.customer_profile_version,
          membership_version: order.membership_version,
          tier_id: order.tier_id,
          addon_cents: order.addon_cents,
          urgent_cents: order.urgent_cents,
          freight_cents: order.freight_cents,
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
