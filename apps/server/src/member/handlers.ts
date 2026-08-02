import { createCommandError } from "@laundry/contracts";

import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import {
  asRecord,
  assertBusinessDayOpen,
  deriveBusinessDate,
  requireNonNegativeInteger,
  requireString,
} from "../order/server-pricing.js";
import { createPgMemberStore } from "./pg-store.js";
import type { MemberRejectReason, MemberStore, MemberTender } from "./types.js";

/**
 * What a runtime provides. Deliberately excludes the order deps: those already
 * exist on the registry input, so composing them here keeps the runtime from
 * having to reference its own half-built object literal.
 */
export type MemberRuntimeDeps = Readonly<{
  persistence?: "memory" | "sql";
  store: MemberStore;
}>;

export type MemberHandlerDeps = MemberRuntimeDeps &
  Readonly<{
    /** Order-side accounting stays the single owner of paid_cents / status. */
    order: OrderHandlerDeps;
  }>;

const RECENT_LEDGER_LIMIT = 50;

/** Maps a store refusal onto the envelope error the bus understands. */
function refusalError(reason: MemberRejectReason): HandlerCommandError {
  switch (reason) {
    // No NOT_FOUND in the envelope's code set; the payment path already maps a
    // missing order to VALIDATION_FAILED, so a missing customer or account
    // reports the same way rather than inventing a code.
    case "customer_not_found":
    case "account_not_found":
    case "bonus_rule_not_found":
      return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    case "account_frozen":
    case "insufficient_balance":
      return new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    case "invalid_amount":
      return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
}

function requirePermission(permissions: readonly string[] | undefined, permission: string): void {
  if (permissions?.includes(permission) !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function resolveStore(
  deps: MemberHandlerDeps,
  context: Parameters<CommandHandler>[0],
): MemberStore {
  return deps.persistence === "sql"
    ? createPgMemberStore(context.client, context.tenant)
    : deps.store;
}

function optionalNote(input: Readonly<Record<string, unknown>>): string | null {
  return typeof input.note === "string" ? input.note : null;
}

const TOPUP_TENDERS: ReadonlySet<string> = new Set(["cash", "wechat", "alipay", "other"]);

/**
 * Narrow the validated top-up method to a ledger tender.
 *
 * The contract schema already restricts this set; refusing anything else here
 * keeps an unpersistable value from reaching the INSERT, where the CHECK would
 * abort the transaction with a far less specific error.
 */
function requireTender(value: unknown): MemberTender {
  const method = requireString(value);
  if (!TOPUP_TENDERS.has(method)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return method as MemberTender;
}

/** Shared clock + business-day gate, identical to the payment path. */
async function openBusinessDate(
  deps: MemberHandlerDeps,
  context: Parameters<CommandHandler>[0],
): Promise<Readonly<{ now: number; businessDate: string }>> {
  const order = deps.order;
  const now = order.now?.() ?? Math.floor(Date.now() / 1000);
  const businessDate = deriveBusinessDate(now, order.timeZone, order.rolloverHour);
  await order.lockBusinessDay?.(context.client, context.tenant, businessDate);
  await assertBusinessDayOpen(order.isBusinessDayClosed, businessDate);
  return Object.freeze({ now, businessDate });
}

export function createMemberHandlers(
  deps: MemberHandlerDeps,
): Readonly<
  Record<
    | "member.account.open"
    | "member.topup"
    | "member.balance.pay"
    | "member.account.get"
    | "member.bonus_rule.upsert"
    | "member.bonus_rules.list",
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
              at: row.at,
              business_date: row.business_date,
              note: row.note,
            }),
          ),
        ),
      }),
    });
  };

  const bonusRuleUpsert: CommandHandler = async (context): Promise<HandlerOutcome> => {
    // Not `catalog_write`: changing a tier changes how much money the shop gives
    // away, which is not the same risk as repricing one service (ADR-22 §2.3).
    requirePermission(context.actor.permissions, "member_rule_write");
    const input = asRecord(context.parsed);
    const outcome = await resolveStore(deps, context).upsertBonusRule({
      rule_id: typeof input.rule_id === "string" ? input.rule_id : null,
      min_topup_cents: requireNonNegativeInteger(input.min_topup_cents),
      bonus_cents: requireNonNegativeInteger(input.bonus_cents),
      status: requireString(input.status) === "retired" ? "retired" : "active",
      staff_id: context.actor.staffId,
      at: (await openBusinessDate(deps, context)).now,
      note: optionalNote(input),
    });
    if (!outcome.ok) throw refusalError(outcome.reason);

    return Object.freeze({
      result: Object.freeze({
        rule_id: outcome.value.rule_id,
        min_topup_cents: outcome.value.min_topup_cents,
        bonus_cents: outcome.value.bonus_cents,
        status: outcome.value.status,
      }),
      audit: Object.freeze({
        entity: "member_bonus_rules",
        entityId: outcome.value.rule_id,
        afterJson: JSON.stringify({
          min_topup_cents: outcome.value.min_topup_cents,
          bonus_cents: outcome.value.bonus_cents,
          status: outcome.value.status,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.bonus_rule_changed",
          payload: Object.freeze({ rule_id: outcome.value.rule_id }),
        }),
      ]),
    });
  };

  const bonusRulesList: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    const input = asRecord(context.parsed);
    const rules = await resolveStore(deps, context).listBonusRules(input.include_retired === true);
    return Object.freeze({
      result: Object.freeze({
        rules: Object.freeze(
          rules.map((rule) =>
            Object.freeze({
              rule_id: rule.rule_id,
              min_topup_cents: rule.min_topup_cents,
              bonus_cents: rule.bonus_cents,
              status: rule.status,
              updated_at: rule.updated_at,
              note: rule.note,
            }),
          ),
        ),
      }),
    });
  };

  return Object.freeze({
    "member.account.open": open,
    "member.topup": topup,
    "member.balance.pay": pay,
    "member.account.get": get,
    "member.bonus_rule.upsert": bonusRuleUpsert,
    "member.bonus_rules.list": bonusRulesList,
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
  queryRegistry?.registerHandler("member.bonus_rules.list", handlers["member.bonus_rules.list"]);
}
