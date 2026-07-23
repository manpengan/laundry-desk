import {
  planCollectPayment,
  planOrderClosure,
  planRefundPayment,
  planRepayPayment,
  type PaymentMethod,
  type PaymentPlanResult,
} from "@laundry/domain";
import { createCommandError } from "@laundry/contracts";
import { randomUUID } from "node:crypto";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/deps.js";
import type { OrderRecord } from "../order/types.js";

type PaymentCommand = "payment.collect" | "payment.repay" | "payment.refund";

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requirePositiveCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireMethod(value: unknown): PaymentMethod {
  if (value === "cash" || value === "wechat" || value === "alipay" || value === "other") {
    return value;
  }
  throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function requireReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function commandFailure(): never {
  throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function requirePaymentPlan(plan: PaymentPlanResult): Extract<PaymentPlanResult, { ok: true }> {
  if (!plan.ok) commandFailure();
  return plan;
}

async function persistPayment(
  deps: OrderHandlerDeps,
  order: OrderRecord,
  plan: Extract<PaymentPlanResult, { ok: true }>,
  staffId: string,
  now: number,
): Promise<HandlerOutcome> {
  if (deps.payments === undefined || deps.store.applyPaymentSummary === undefined) {
    throw new Error("Counter payment stores are required");
  }
  const garments = await deps.store.listGarments(order.org_id, order.store_id, order.order_id);
  const closure = planOrderClosure({
    status: order.status,
    garment_statuses: garments.map((garment) => garment.status),
    balance_cents: plan.balance_cents,
  });
  if (!closure.ok) commandFailure();
  const applied = await deps.store.applyPaymentSummary({
    orgId: order.org_id,
    storeId: order.store_id,
    orderId: order.order_id,
    staffId,
    expectedPaidCents: order.paid_cents,
    expectedBalanceCents: order.balance_cents,
    paidCents: plan.paid_cents,
    balanceCents: plan.balance_cents,
    nextStatus: closure.next_status,
    nowEpoch: now,
  });
  if (!applied) throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  await deps.payments.appendPayment(plan.payment);
  return Object.freeze({
    result: Object.freeze({
      order_id: order.order_id,
      payment_id: plan.payment.payment_id,
      kind: plan.payment.kind,
      paid_cents: plan.paid_cents,
      balance_cents: plan.balance_cents,
      status: closure.next_status,
    }),
    audit: Object.freeze({
      entity: "payment",
      entityId: plan.payment.payment_id,
      afterJson: JSON.stringify({
        order_id: order.order_id,
        kind: plan.payment.kind,
        amount_cents: plan.payment.amount_cents,
        balance_cents: plan.balance_cents,
      }),
    }),
    events: Object.freeze([
      Object.freeze({
        type: `payment.${plan.payment.kind}`,
        payload: Object.freeze({ order_id: order.order_id, payment_id: plan.payment.payment_id }),
      }),
    ]),
  });
}

function collectionHandler(deps: OrderHandlerDeps, command: PaymentCommand): CommandHandler {
  return async (ctx) => {
    if (deps.payments === undefined) throw new Error("Counter payment store is required");
    const input = asRecord(ctx.parsed);
    const orderId = requireId(input.order_id);
    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null || order.status !== "open") commandFailure();
    const payments = await deps.payments.listPayments(order.org_id, order.store_id, order.order_id);
    const base = Object.freeze({
      payment_id: (deps.newId ?? randomUUID)(),
      org_id: order.org_id,
      store_id: order.store_id,
      order_id: order.order_id,
      amount_cents: requirePositiveCents(input.amount_cents),
      staff_id: ctx.actor.staffId,
      at: deps.now?.() ?? Math.floor(Date.now() / 1000),
      method: requireMethod(input.method),
      ...(typeof input.note === "string" ? { note: input.note } : {}),
      payable_cents: order.payable_cents,
      existing_payments: payments,
    });
    const plan = requirePaymentPlan(
      command === "payment.collect" ? planCollectPayment(base) : planRepayPayment(base),
    );
    return persistPayment(deps, order, plan, ctx.actor.staffId, base.at);
  };
}

function refundHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx) => {
    if (deps.payments === undefined) throw new Error("Counter payment store is required");
    const input = asRecord(ctx.parsed);
    const orderId = requireId(input.order_id);
    const order = await deps.store.getOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    if (order === null || order.status !== "open") commandFailure();
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const plan = requirePaymentPlan(
      planRefundPayment({
        payment_id: (deps.newId ?? randomUUID)(),
        org_id: order.org_id,
        store_id: order.store_id,
        order_id: order.order_id,
        amount_cents: requirePositiveCents(input.amount_cents),
        staff_id: ctx.actor.staffId,
        at: now,
        method: requireMethod(input.method),
        ...(typeof input.note === "string" ? { note: input.note } : {}),
        payable_cents: order.payable_cents,
        existing_payments: await deps.payments.listPayments(
          order.org_id,
          order.store_id,
          order.order_id,
        ),
        ref_payment_id: requireId(input.ref_payment_id),
        reason: requireReason(input.reason),
      }),
    );
    return persistPayment(deps, order, plan, ctx.actor.staffId, now);
  };
}

export function createPaymentHandlers(
  deps: OrderHandlerDeps,
): Readonly<Record<PaymentCommand, CommandHandler>> {
  return Object.freeze({
    "payment.collect": collectionHandler(deps, "payment.collect"),
    "payment.repay": collectionHandler(deps, "payment.repay"),
    "payment.refund": refundHandler(deps),
  });
}

export function registerPaymentCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: OrderHandlerDeps,
): void {
  const handlers = createPaymentHandlers(deps);
  registry.registerHandler("payment.collect", handlers["payment.collect"]);
  registry.registerHandler("payment.repay", handlers["payment.repay"]);
  registry.registerHandler("payment.refund", handlers["payment.refund"]);
}
