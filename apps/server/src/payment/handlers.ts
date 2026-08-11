import { PaymentLedgerListInputSchema, createCommandError } from "@laundry/contracts";
import { projectPaymentLedger } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/deps.js";
import {
  asRecord,
  assertBusinessDayOpen,
  deriveBusinessDate,
  requireNonNegativeInteger,
  requireString,
} from "../order/server-pricing.js";

const paymentMethods = new Set(["cash", "wechat", "alipay", "other"]);
const MAX_LEDGER_ROWS = 200;

function requirePaymentMethod(value: unknown): "cash" | "wechat" | "alipay" | "other" {
  const method = requireString(value);
  if (!paymentMethods.has(method)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return method as "cash" | "wechat" | "alipay" | "other";
}

function paymentHandler(kind: "pay" | "repay", deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    if (deps.store.appendPayment === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
    const amountCents = requireNonNegativeInteger(input.amount_cents);
    if (amountCents === 0) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const method = requirePaymentMethod(input.method);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await deps.lockBusinessDay?.(ctx.client, ctx.tenant, businessDate);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const result = await deps.store.appendPayment({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      order_id: orderId,
      amount_cents: amountCents,
      method,
      note: typeof input.note === "string" ? input.note : null,
      kind,
      staff_id: ctx.actor.staffId,
      at: now,
      business_date: businessDate,
    });
    if (result === null) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    return Object.freeze({
      result: Object.freeze({
        order_id: result.order.order_id,
        payment_id: result.payment.payment_id,
        kind: result.payment.kind,
        paid_cents: result.order.paid_cents,
        balance_cents: result.order.balance_cents,
        status: result.order.status,
      }),
      audit: Object.freeze({
        entity: "payment",
        entityId: result.payment.payment_id,
        afterJson: JSON.stringify({
          order_id: result.order.order_id,
          amount_cents: result.payment.amount_cents,
          kind: result.payment.kind,
          method: result.payment.method,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: kind === "pay" ? "payment.collected" : "payment.repaid",
          payload: Object.freeze({
            order_id: result.order.order_id,
            payment_id: result.payment.payment_id,
          }),
        }),
      ]),
    });
  };
}

function refundHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    if (deps.store.appendRefund === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = asRecord(ctx.parsed);
    const orderId = requireString(input.order_id);
    const amountCents = requireNonNegativeInteger(input.amount_cents);
    if (amountCents === 0) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const refPaymentId = requireString(input.ref_payment_id);
    const expectedMethod = requirePaymentMethod(input.method);
    const reason = requireString(input.reason).trim();
    if (reason.length === 0 || reason.length > 256) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const businessDate = deriveBusinessDate(now, deps.timeZone, deps.rolloverHour);
    await deps.lockBusinessDay?.(ctx.client, ctx.tenant, businessDate);
    await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
    const result = await deps.store.appendRefund({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      order_id: orderId,
      amount_cents: amountCents,
      expected_method: expectedMethod,
      ref_payment_id: refPaymentId,
      reason,
      staff_id: ctx.actor.staffId,
      at: now,
      business_date: businessDate,
    });
    if (result === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result: Object.freeze({
        order_id: result.order.order_id,
        payment_id: result.payment.payment_id,
        kind: result.payment.kind,
        ref_payment_id: result.payment.ref_payment_id,
        paid_cents: result.order.paid_cents,
        balance_cents: result.order.balance_cents,
        status: result.order.status,
      }),
      audit: Object.freeze({
        entity: "payment",
        entityId: result.payment.payment_id,
        afterJson: JSON.stringify({
          order_id: result.order.order_id,
          amount_cents: result.payment.amount_cents,
          kind: result.payment.kind,
          method: result.payment.method,
          ref_payment_id: result.payment.ref_payment_id,
          reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "payment.refunded",
          payload: Object.freeze({
            order_id: result.order.order_id,
            payment_id: result.payment.payment_id,
            ref_payment_id: result.payment.ref_payment_id,
          }),
        }),
      ]),
    });
  };
}

function ledgerListHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    if (deps.store.listPayments === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const parsed = PaymentLedgerListInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const order = await deps.store.getOrder(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      parsed.data.order_id,
    );
    if (order === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const payments = await deps.store.listPayments(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      order.order_id,
      MAX_LEDGER_ROWS + 1,
    );
    if (payments.length > MAX_LEDGER_ROWS) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const ledger = projectPaymentLedger(order.payable_cents, payments);
    if (!ledger.ok) {
      throw new Error(`Invalid payment ledger: ${ledger.reason}`);
    }
    const projectionMatches =
      order.status === "cancelled"
        ? ledger.paid_cents === 0 && order.paid_cents === 0 && order.balance_cents === 0
        : ledger.paid_cents === order.paid_cents && ledger.balance_cents === order.balance_cents;
    if (!projectionMatches) {
      throw new Error("Payment ledger does not match the order projection");
    }
    return Object.freeze({
      result: Object.freeze({
        order_id: order.order_id,
        order_status: order.status,
        payable_cents: order.payable_cents,
        paid_cents: order.paid_cents,
        balance_cents: order.balance_cents,
        payments: Object.freeze(
          ledger.rows.map((payment) =>
            Object.freeze({
              payment_id: payment.payment_id,
              kind: payment.kind,
              method: payment.method,
              amount_cents: payment.amount_cents,
              signed_cents: payment.signed_cents,
              ref_payment_id: payment.ref_payment_id,
              at: payment.at,
              note: payment.note,
              active: payment.active,
              refundable_cents: payment.refundable_cents,
            }),
          ),
        ),
      }),
    });
  };
}

export function registerPaymentCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: OrderHandlerDeps,
): void {
  registry.registerHandler("payment.collect", paymentHandler("pay", deps));
  registry.registerHandler("payment.repay", paymentHandler("repay", deps));
  registry.registerHandler("payment.refund", refundHandler(deps));
}

export function registerPaymentQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: OrderHandlerDeps,
): void {
  registry.registerHandler("payment.ledger.list", ledgerListHandler(deps));
}
