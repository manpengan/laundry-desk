import {
  buildReversalPayment,
  derivePaymentLedger,
  planCancel,
  planHold,
  type PaymentRow,
} from "@laundry/domain";
import { createCommandError } from "@laundry/contracts";
import { randomUUID } from "node:crypto";

import type { CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";

type LifecycleCommand = "order.hold" | "order.cancel";

function parsedRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function unavailable(): never {
  throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
}

function holdHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx) => {
    if (deps.store.holdOrder === undefined) unavailable();
    const input = parsedRecord(ctx.parsed);
    const orderId = requiredString(input.order_id);
    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null) unavailable();
    const plan = planHold({ status: order.status, reason: requiredString(input.reason) });
    if (!plan.ok) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const held = await deps.store.holdOrder({
      orgId: order.org_id,
      storeId: order.store_id,
      orderId: order.order_id,
      staffId: ctx.actor.staffId,
      reason: plan.reason,
      nowEpoch: now,
    });
    if (!held) unavailable();
    return Object.freeze({
      result: Object.freeze({ order_id: order.order_id, status: "open" as const, held: true }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({ held: true, reason: plan.reason }),
      }),
      events: Object.freeze([
        Object.freeze({ type: "order.held", payload: Object.freeze({ order_id: order.order_id }) }),
      ]),
    });
  };
}

function reversalRows(
  order: Readonly<{ org_id: string; store_id: string; order_id: string }>,
  payments: readonly PaymentRow[],
  payableCents: number,
  reason: string,
  staffId: string,
  now: number,
  newId: () => string,
): readonly PaymentRow[] {
  const sourceById = new Map(payments.map((payment) => [payment.payment_id, payment]));
  const plan = planCancel({
    status: "open",
    reason,
    payable_cents: payableCents,
    payments,
  });
  if (!plan.ok) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  return Object.freeze(
    plan.reversal_targets.map((target) => {
      const source = sourceById.get(target.payment_id);
      if (source === undefined) unavailable();
      return buildReversalPayment({
        payment_id: newId(),
        org_id: order.org_id,
        store_id: order.store_id,
        order_id: order.order_id,
        amount_cents: target.amount_cents,
        staff_id: staffId,
        at: now,
        method: source.method,
        ref_payment_id: source.payment_id,
        reason,
      });
    }),
  );
}

function cancelHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx) => {
    if (deps.payments === undefined || deps.store.cancelOrder === undefined) unavailable();
    const input = parsedRecord(ctx.parsed);
    const orderId = requiredString(input.order_id);
    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null) unavailable();
    const reason = requiredString(input.reason).trim();
    const payments = await deps.payments.listPayments(order.org_id, order.store_id, order.order_id);
    const plan = planCancel({
      status: order.status,
      reason,
      payable_cents: order.payable_cents,
      payments,
    });
    if (!plan.ok) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const rows = reversalRows(
      order,
      payments,
      order.payable_cents,
      plan.reason,
      ctx.actor.staffId,
      now,
      deps.newId ?? randomUUID,
    );
    const projection = derivePaymentLedger(order.payable_cents, [...payments, ...rows]);
    if (!projection.ok) unavailable();
    const cancelled = await deps.store.cancelOrder({
      orgId: order.org_id,
      storeId: order.store_id,
      orderId: order.order_id,
      staffId: ctx.actor.staffId,
      expectedPaidCents: order.paid_cents,
      expectedBalanceCents: order.balance_cents,
      paidCents: projection.paid_cents,
      balanceCents: projection.balance_cents,
      nextStatus: "cancelled",
      nowEpoch: now,
      reason: plan.reason,
    });
    if (!cancelled) unavailable();
    for (const row of rows) await deps.payments.appendPayment(row);
    return Object.freeze({
      result: Object.freeze({
        order_id: order.order_id,
        status: "cancelled" as const,
        reversed_payment_ids: rows.map((row) => row.payment_id),
      }),
      audit: Object.freeze({
        entity: "order",
        entityId: order.order_id,
        afterJson: JSON.stringify({ reason: plan.reason, reversed_payment_count: rows.length }),
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

export function createOrderLifecycleHandlers(
  deps: OrderHandlerDeps,
): Readonly<Record<LifecycleCommand, CommandHandler>> {
  return Object.freeze({
    "order.hold": holdHandler(deps),
    "order.cancel": cancelHandler(deps),
  });
}
