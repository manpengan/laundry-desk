/**
 * Shared plumbing for the member handlers.
 *
 * Extracted so the money path (account, top-up, settle, refund) and the tier
 * maintenance path can live in separate files: they are different concerns, and
 * together they pushed one file past the 400-line gate.
 */

import { createCommandError } from "@laundry/contracts";

import { HandlerCommandError, type CommandHandler } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import {
  assertBusinessDayOpen,
  deriveBusinessDate,
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

export const RECENT_LEDGER_LIMIT = 50;

/** Maps a store refusal onto the envelope error the bus understands. */
export function refusalError(reason: MemberRejectReason): HandlerCommandError {
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

export function requirePermission(
  permissions: readonly string[] | undefined,
  permission: string,
): void {
  if (permissions?.includes(permission) !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

export function resolveStore(
  deps: MemberHandlerDeps,
  context: Parameters<CommandHandler>[0],
): MemberStore {
  return deps.persistence === "sql"
    ? createPgMemberStore(context.client, context.tenant)
    : deps.store;
}

export function optionalNote(input: Readonly<Record<string, unknown>>): string | null {
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
export function requireTender(value: unknown): MemberTender {
  const method = requireString(value);
  if (!TOPUP_TENDERS.has(method)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return method as MemberTender;
}

/** Shared clock + business-day gate, identical to the payment path. */
export async function openBusinessDate(
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
