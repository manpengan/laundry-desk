/**
 * order.list query handler — newest-first store order history.
 */

import { createCommandError } from "@laundry/contracts";
import { utcDateKeyFromEpoch } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import type { OrderRecord, OrderStatus } from "./types.js";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function optionalStatus(value: unknown): OrderStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "open" || value === "closed" || value === "cancelled") return value;
  throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function listLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  const n = requireNumber(value);
  if (n < 1 || n > MAX_LIST_LIMIT) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return n;
}

function matchesListFilters(
  order: OrderRecord,
  businessDate: string | undefined,
  status: OrderStatus | undefined,
): boolean {
  if (status !== undefined && order.status !== status) return false;
  if (businessDate !== undefined && utcDateKeyFromEpoch(order.created_at) !== businessDate) {
    return false;
  }
  return true;
}

export function listHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const businessDate = typeof input.business_date === "string" ? input.business_date : undefined;
    const status = optionalStatus(input.status);
    const limit = listLimit(input.limit);

    if (deps.store.listOrders === undefined) {
      return Object.freeze({ result: Object.freeze({ orders: Object.freeze([]) }) });
    }

    const all = await deps.store.listOrders(ctx.tenant.orgId, ctx.tenant.storeId);
    const filtered = all
      .filter((order) => matchesListFilters(order, businessDate, status))
      .slice()
      .sort((a, b) => b.created_at - a.created_at || b.ticket_no.localeCompare(a.ticket_no))
      .slice(0, limit);

    const rows = [];
    for (const order of filtered) {
      const garments = await deps.store.listGarments(
        ctx.tenant.orgId,
        ctx.tenant.storeId,
        order.order_id,
      );
      rows.push(
        Object.freeze({
          order_id: order.order_id,
          ticket_no: order.ticket_no,
          status: order.status,
          customer_phone: order.customer_phone,
          customer_name: order.customer_name,
          payable_cents: order.payable_cents,
          paid_cents: order.paid_cents,
          balance_cents: order.balance_cents,
          created_at: order.created_at,
          garment_count: garments.length,
        }),
      );
    }

    return Object.freeze({
      result: Object.freeze({ orders: Object.freeze(rows) }),
    });
  };
}
