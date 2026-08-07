import { createCommandError } from "@laundry/contracts";

import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import { asRecord, requireNonNegativeInteger, requireString } from "../order/server-pricing.js";
import { createMemberBonusHandlers } from "./bonus-handlers.js";
import { createMemberLifecycleHandlers } from "./lifecycle-handlers.js";
import {
  openBusinessDate,
  optionalNote,
  refusalError,
  requirePermission,
  requireTender,
  resolveStore,
  RECENT_LEDGER_LIMIT,
  type MemberHandlerDeps,
  type MemberRuntimeDeps,
} from "./handler-support.js";

export type { MemberHandlerDeps, MemberRuntimeDeps };

export function createMemberHandlers(
  deps: MemberHandlerDeps,
): Readonly<
  Record<
    | "member.account.open"
    | "member.topup"
    | "member.balance.pay"
    | "member.account.get"
    | "member.bonus_rule.upsert"
    | "member.bonus_rules.list"
    | "member.refund"
    | "member.account.freeze"
    | "member.account.unfreeze"
    | "member.account.close",
    CommandHandler
  >
> {
  const open: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_write");
    const input = asRecord(context.parsed);
    const customerId = requireString(input.customer_id);
    const now = deps.order.now?.() ?? Math.floor(Date.now() / 1000);
    const outcome = await resolveStore(deps, context).openAccount({
      customer_id: customerId,
      store_id: context.tenant.storeId,
      at: now,
    });
    if (!outcome.ok) throw refusalError(outcome.reason);
    return Object.freeze({
      result: Object.freeze({
        account_id: outcome.value.account.account_id,
        customer_id: outcome.value.account.customer_id,
        status: outcome.value.account.status,
        created: outcome.value.created,
      }),
      audit: Object.freeze({
        entity: "member_account",
        entityId: outcome.value.account.account_id,
        afterJson: JSON.stringify({
          customer_id: outcome.value.account.customer_id,
          created: outcome.value.created,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.account_opened",
          payload: Object.freeze({ account_id: outcome.value.account.account_id }),
        }),
      ]),
    });
  };

  const topup: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_write");
    const input = asRecord(context.parsed);
    const accountId = requireString(input.account_id);
    const amountCents = requireNonNegativeInteger(input.amount_cents);
    if (amountCents === 0) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const method = requireTender(input.method);
    const { now, businessDate } = await openBusinessDate(deps, context);
    const outcome = await resolveStore(deps, context).topup({
      account_id: accountId,
      store_id: context.tenant.storeId,
      amount_cents: amountCents,
      // Persisted, not just audited: the day's cash depends on it (ADR-22 §1).
      tender: method,
      staff_id: context.actor.staffId,
      at: now,
      business_date: businessDate,
      note: optionalNote(input),
    });
    if (!outcome.ok) throw refusalError(outcome.reason);
    return Object.freeze({
      result: Object.freeze({
        account_id: outcome.value.account_id,
        ledger_id: outcome.value.ledger_id,
        principal_cents: outcome.value.balance.principal_cents,
        bonus_cents: outcome.value.balance.bonus_cents,
        balance_cents: outcome.value.balance.total_cents,
      }),
      audit: Object.freeze({
        entity: "member_ledger",
        entityId: outcome.value.ledger_id,
        afterJson: JSON.stringify({
          account_id: outcome.value.account_id,
          kind: "topup",
          amount_cents: amountCents,
          method,
          balance_cents: outcome.value.balance.total_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.topped_up",
          payload: Object.freeze({
            account_id: outcome.value.account_id,
            ledger_id: outcome.value.ledger_id,
          }),
        }),
      ]),
    });
  };

  const pay: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "order_write");
    if (deps.order.store.appendPayment === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = asRecord(context.parsed);
    const accountId = requireString(input.account_id);
    const orderId = requireString(input.order_id);
    const amountCents = requireNonNegativeInteger(input.amount_cents);
    if (amountCents === 0) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const { now, businessDate } = await openBusinessDate(deps, context);
    const note = optionalNote(input);

    // Ledger first: it takes the account lock and refuses an overdraw before any
    // order row moves. Both writes share this transaction, so a later order-side
    // rejection rolls the debit back with it.
    const debited = await resolveStore(deps, context).spend({
      account_id: accountId,
      store_id: context.tenant.storeId,
      order_id: orderId,
      amount_cents: amountCents,
      staff_id: context.actor.staffId,
      at: now,
      business_date: businessDate,
      note,
    });
    if (!debited.ok) throw refusalError(debited.reason);

    const settled = await deps.order.store.appendPayment({
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      order_id: orderId,
      amount_cents: amountCents,
      method: "balance",
      note,
      kind: "pay",
      staff_id: context.actor.staffId,
      at: now,
      business_date: businessDate,
    });
    if (settled === null) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));

    return Object.freeze({
      result: Object.freeze({
        account_id: debited.value.account_id,
        ledger_id: debited.value.ledger_id,
        order_id: settled.order.order_id,
        payment_id: settled.payment.payment_id,
        balance_cents: debited.value.balance.total_cents,
        order_paid_cents: settled.order.paid_cents,
        order_balance_cents: settled.order.balance_cents,
        status: settled.order.status,
      }),
      audit: Object.freeze({
        entity: "member_ledger",
        entityId: debited.value.ledger_id,
        afterJson: JSON.stringify({
          account_id: debited.value.account_id,
          kind: "pay",
          amount_cents: amountCents,
          order_id: settled.order.order_id,
          payment_id: settled.payment.payment_id,
          balance_cents: debited.value.balance.total_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.balance_spent",
          payload: Object.freeze({
            account_id: debited.value.account_id,
            order_id: settled.order.order_id,
            payment_id: settled.payment.payment_id,
          }),
        }),
      ]),
    });
  };

  const get: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    const input = asRecord(context.parsed);
    const customerId = requireString(input.customer_id);
    const view = await resolveStore(deps, context).getByCustomer(customerId, RECENT_LEDGER_LIMIT);
    if (view === null) {
      return Object.freeze({ result: Object.freeze({ account: null, recent: Object.freeze([]) }) });
    }
    return Object.freeze({
      result: Object.freeze({
        account: Object.freeze({
          account_id: view.account.account_id,
          customer_id: view.account.customer_id,
          status: view.account.status,
          status_version: view.account.status_version,
          status_changed_at: view.account.status_changed_at,
          status_reason: view.account.status_reason,
          principal_cents: view.balance.principal_cents,
          bonus_cents: view.balance.bonus_cents,
          balance_cents: view.balance.total_cents,
        }),
        recent: Object.freeze(
          view.recent.map((row) =>
            Object.freeze({
              ledger_id: row.ledger_id,
              kind: row.kind,
              principal_delta_cents: row.principal_delta_cents,
              bonus_delta_cents: row.bonus_delta_cents,
              order_id: row.order_id,
              store_id: row.store_id,
              tender: row.tender,
              bonus_rule_id: row.bonus_rule_id,
              at: row.at,
              business_date: row.business_date,
              note: row.note,
            }),
          ),
        ),
      }),
    });
  };

  const refund: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "member_refund");
    const input = asRecord(context.parsed);
    const accountId = requireString(input.account_id);
    const amountCents = requireNonNegativeInteger(input.amount_cents);
    if (amountCents === 0) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const tender = requireTender(input.tender);
    const reason = requireString(input.reason);
    if (reason.trim().length === 0) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const { now, businessDate } = await openBusinessDate(deps, context);
    const outcome = await resolveStore(deps, context).refund({
      account_id: accountId,
      store_id: context.tenant.storeId,
      amount_cents: amountCents,
      tender,
      reason,
      staff_id: context.actor.staffId,
      at: now,
      business_date: businessDate,
      note: optionalNote(input),
    });
    if (!outcome.ok) throw refusalError(outcome.reason);

    return Object.freeze({
      result: Object.freeze({
        account_id: outcome.value.account_id,
        ledger_id: outcome.value.ledger_id,
        refunded_cents: amountCents,
        principal_cents: outcome.value.balance.principal_cents,
        bonus_cents: outcome.value.balance.bonus_cents,
        balance_cents: outcome.value.balance.total_cents,
      }),
      audit: Object.freeze({
        entity: "member_ledger",
        entityId: outcome.value.ledger_id,
        afterJson: JSON.stringify({
          account_id: outcome.value.account_id,
          kind: "refund",
          amount_cents: amountCents,
          tender,
          reason,
          balance_cents: outcome.value.balance.total_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.refunded",
          payload: Object.freeze({
            account_id: outcome.value.account_id,
            ledger_id: outcome.value.ledger_id,
          }),
        }),
      ]),
    });
  };

  const bonusHandlers = createMemberBonusHandlers(deps);
  const lifecycleHandlers = createMemberLifecycleHandlers(deps);

  return Object.freeze({
    "member.account.open": open,
    "member.topup": topup,
    "member.balance.pay": pay,
    "member.account.get": get,
    "member.bonus_rule.upsert": bonusHandlers["member.bonus_rule.upsert"],
    "member.bonus_rules.list": bonusHandlers["member.bonus_rules.list"],
    "member.refund": refund,
    "member.account.freeze": lifecycleHandlers["member.account.freeze"],
    "member.account.unfreeze": lifecycleHandlers["member.account.unfreeze"],
    "member.account.close": lifecycleHandlers["member.account.close"],
  });
}

export function registerMemberHandlers(
  commandRegistry: MutableCommandRegistry,
  queryRegistry: MutableQueryRegistry | null,
  deps: MemberHandlerDeps,
): void {
  const handlers = createMemberHandlers(deps);
  commandRegistry.registerHandler("member.account.open", handlers["member.account.open"]);
  commandRegistry.registerHandler("member.topup", handlers["member.topup"]);
  commandRegistry.registerHandler("member.balance.pay", handlers["member.balance.pay"]);
  commandRegistry.registerHandler("member.bonus_rule.upsert", handlers["member.bonus_rule.upsert"]);
  queryRegistry?.registerHandler("member.account.get", handlers["member.account.get"]);
  commandRegistry.registerHandler("member.refund", handlers["member.refund"]);
  commandRegistry.registerHandler("member.account.freeze", handlers["member.account.freeze"]);
  commandRegistry.registerHandler("member.account.unfreeze", handlers["member.account.unfreeze"]);
  commandRegistry.registerHandler("member.account.close", handlers["member.account.close"]);
  queryRegistry?.registerHandler("member.bonus_rules.list", handlers["member.bonus_rules.list"]);
}
