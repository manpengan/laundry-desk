import { createCommandError } from "@laundry/contracts";

import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import { asRecord, requireNonNegativeInteger, requireString } from "../order/server-pricing.js";
import {
  openBusinessDate,
  refusalError,
  requirePermission,
  requireTender,
  resolveStore,
  type MemberHandlerDeps,
} from "./handler-support.js";
import type { MemberTender } from "./types.js";

type LifecycleHandlerName =
  "member.account.freeze" | "member.account.unfreeze" | "member.account.close";

const invalid = (): never => {
  throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
};

function positiveInteger(value: unknown): number {
  const parsed = requireNonNegativeInteger(value);
  if (parsed === 0) invalid();
  return parsed;
}

function reasonFrom(input: Readonly<Record<string, unknown>>): string {
  const reason = requireString(input.reason);
  if (reason !== reason.trim() || reason.trim().length === 0 || reason.length > 256) invalid();
  return reason;
}

function closeStatus(value: unknown): "active" | "frozen" {
  if (value === "active" || value === "frozen") return value;
  return invalid();
}

function closeTender(expectedPrincipal: number, value: unknown): MemberTender | null {
  if (expectedPrincipal === 0) {
    if (value !== null) invalid();
    return null;
  }
  return requireTender(value);
}

function transitionHandler(deps: MemberHandlerDeps, action: "freeze" | "unfreeze"): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    requirePermission(
      context.actor.permissions,
      action === "freeze" ? "member_freeze" : "member_lifecycle_manage",
    );
    const input = asRecord(context.parsed);
    const accountId = requireString(input.account_id);
    const expectedCustomerId = requireString(input.expected_customer_id);
    const expectedVersion = positiveInteger(input.expected_status_version);
    const reason = reasonFrom(input);
    const now = deps.order.now?.() ?? Math.floor(Date.now() / 1000);
    const outcome = await resolveStore(deps, context).transitionStatus({
      account_id: accountId,
      expected_customer_id: expectedCustomerId,
      expected_status_version: expectedVersion,
      action,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      at: now,
      reason,
    });
    if (!outcome.ok) throw refusalError(outcome.reason);
    return Object.freeze({
      result: Object.freeze({
        account_id: outcome.value.account.account_id,
        customer_id: outcome.value.account.customer_id,
        status: outcome.value.account.status,
        status_version: outcome.value.account.status_version,
        status_changed_at: outcome.value.account.status_changed_at,
      }),
      audit: Object.freeze({
        entity: "member_account",
        entityId: outcome.value.account.account_id,
        beforeJson: JSON.stringify({
          customer_id: outcome.value.account.customer_id,
          status: outcome.value.previous_status,
          status_version: expectedVersion,
        }),
        afterJson: JSON.stringify({
          customer_id: outcome.value.account.customer_id,
          status: outcome.value.account.status,
          status_version: outcome.value.account.status_version,
          reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: action === "freeze" ? "member.account_frozen" : "member.account_unfrozen",
          payload: Object.freeze({
            account_id: outcome.value.account.account_id,
            status_version: outcome.value.account.status_version,
          }),
        }),
      ]),
    });
  };
}

function closeHandler(deps: MemberHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "member_lifecycle_manage");
    requirePermission(context.actor.permissions, "member_refund");
    const input = asRecord(context.parsed);
    const expectedPrincipal = requireNonNegativeInteger(input.expected_principal_cents);
    const expectedBonus = requireNonNegativeInteger(input.expected_bonus_cents);
    const reason = reasonFrom(input);
    const { now, businessDate } = await openBusinessDate(deps, context);
    const outcome = await resolveStore(deps, context).close({
      account_id: requireString(input.account_id),
      expected_customer_id: requireString(input.expected_customer_id),
      expected_status_version: positiveInteger(input.expected_status_version),
      expected_status: closeStatus(input.expected_status),
      expected_principal_cents: expectedPrincipal,
      expected_bonus_cents: expectedBonus,
      refund_tender: closeTender(expectedPrincipal, input.refund_tender),
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      at: now,
      business_date: businessDate,
      reason,
    });
    if (!outcome.ok) throw refusalError(outcome.reason);
    const account = outcome.value.account;
    const events = [
      Object.freeze({
        type: "member.account_closed",
        payload: Object.freeze({
          account_id: account.account_id,
          status_version: account.status_version,
          refund_ledger_id: outcome.value.refund_ledger_id,
          bonus_forfeit_ledger_id: outcome.value.bonus_forfeit_ledger_id,
        }),
      }),
      ...(outcome.value.refunded_principal_cents > 0
        ? [
            Object.freeze({
              type: "member.principal_refunded",
              payload: Object.freeze({
                account_id: account.account_id,
                ledger_id: outcome.value.refund_ledger_id,
                amount_cents: outcome.value.refunded_principal_cents,
              }),
            }),
          ]
        : []),
      ...(outcome.value.forfeited_bonus_cents > 0
        ? [
            Object.freeze({
              type: "member.bonus_forfeited",
              payload: Object.freeze({
                account_id: account.account_id,
                ledger_id: outcome.value.bonus_forfeit_ledger_id,
                amount_cents: outcome.value.forfeited_bonus_cents,
              }),
            }),
          ]
        : []),
    ];
    return Object.freeze({
      result: Object.freeze({
        account_id: account.account_id,
        customer_id: account.customer_id,
        status: account.status,
        status_version: account.status_version,
        refunded_principal_cents: outcome.value.refunded_principal_cents,
        forfeited_bonus_cents: outcome.value.forfeited_bonus_cents,
        refund_ledger_id: outcome.value.refund_ledger_id,
        bonus_forfeit_ledger_id: outcome.value.bonus_forfeit_ledger_id,
        principal_cents: outcome.value.balance.principal_cents,
        bonus_cents: outcome.value.balance.bonus_cents,
        balance_cents: outcome.value.balance.total_cents,
      }),
      audit: Object.freeze({
        entity: "member_account",
        entityId: account.account_id,
        beforeJson: JSON.stringify({
          customer_id: account.customer_id,
          status: outcome.value.previous_status,
          status_version: input.expected_status_version,
          principal_cents: expectedPrincipal,
          bonus_cents: expectedBonus,
        }),
        afterJson: JSON.stringify({
          customer_id: account.customer_id,
          status: account.status,
          status_version: account.status_version,
          refunded_principal_cents: outcome.value.refunded_principal_cents,
          forfeited_bonus_cents: outcome.value.forfeited_bonus_cents,
          refund_ledger_id: outcome.value.refund_ledger_id,
          bonus_forfeit_ledger_id: outcome.value.bonus_forfeit_ledger_id,
          refund_tender: input.refund_tender,
          reason,
        }),
      }),
      events: Object.freeze(events),
    });
  };
}

export function createMemberLifecycleHandlers(
  deps: MemberHandlerDeps,
): Readonly<Record<LifecycleHandlerName, CommandHandler>> {
  return Object.freeze({
    "member.account.freeze": transitionHandler(deps, "freeze"),
    "member.account.unfreeze": transitionHandler(deps, "unfreeze"),
    "member.account.close": closeHandler(deps),
  });
}
