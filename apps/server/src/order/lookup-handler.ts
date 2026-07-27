/** Bounded server-side counter lookup; the browser never scans an unfiltered order list. */

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import type {
  OrderLookupMatchKind,
  OrderLookupOptions,
  OrderLookupSummary,
  OrderRecord,
  OrderStatus,
} from "./types.js";

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalStatus(value: unknown): OrderStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "draft" || value === "open" || value === "closed" || value === "cancelled") {
    return value;
  }
  throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function lookupLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function matchKind(
  order: OrderRecord,
  garmentBarcodes: readonly string[],
  key: string,
): OrderLookupMatchKind | null {
  const upper = key.toUpperCase();
  if (order.ticket_no?.toUpperCase() === upper) return "ticket_no";
  if (order.pickup_code?.toUpperCase() === upper) return "pickup_code";
  if (garmentBarcodes.some((barcode) => barcode.toUpperCase() === upper)) {
    return "garment_barcode";
  }
  if (order.customer_phone === key) return "customer_phone";
  if (order.customer_name?.toLocaleLowerCase().startsWith(key.toLocaleLowerCase())) {
    return "customer_name";
  }
  return null;
}

function matchRank(kind: OrderLookupMatchKind): number {
  return ["ticket_no", "pickup_code", "garment_barcode", "customer_phone", "customer_name"].indexOf(
    kind,
  );
}

async function inMemoryLookup(
  deps: OrderHandlerDeps,
  orgId: string,
  storeId: string,
  options: OrderLookupOptions,
): Promise<readonly OrderLookupSummary[]> {
  if (deps.store.listOrders === undefined) return Object.freeze([]);
  const candidates: OrderLookupSummary[] = [];
  for (const order of await deps.store.listOrders(orgId, storeId)) {
    if (options.status !== undefined && order.status !== options.status) continue;
    const garments = await deps.store.listGarments(orgId, storeId, order.order_id);
    const matchedBy = matchKind(
      order,
      garments.map((garment) => garment.barcode),
      options.key,
    );
    if (matchedBy === null) continue;
    candidates.push(
      Object.freeze({
        order_id: order.order_id,
        ticket_no: order.ticket_no,
        pickup_code: order.pickup_code,
        status: order.status,
        customer_phone: order.customer_phone,
        customer_name: order.customer_name,
        payable_cents: order.payable_cents,
        paid_cents: order.paid_cents,
        balance_cents: order.balance_cents,
        created_at: order.created_at,
        garment_count: garments.length,
        matched_by: matchedBy,
      }),
    );
  }
  return Object.freeze(
    candidates
      .sort(
        (left, right) =>
          matchRank(left.matched_by) - matchRank(right.matched_by) ||
          right.created_at - left.created_at ||
          (right.ticket_no ?? "").localeCompare(left.ticket_no ?? ""),
      )
      .slice(0, options.limit),
  );
}

export function lookupHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    if (typeof input.key !== "string" || input.key.length === 0) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const status = optionalStatus(input.status);
    const options: OrderLookupOptions = Object.freeze({
      key: input.key,
      ...(status === undefined ? {} : { status }),
      limit: lookupLimit(input.limit),
    });
    const orders =
      deps.store.lookupOrderSummaries === undefined
        ? await inMemoryLookup(deps, ctx.tenant.orgId, ctx.tenant.storeId, options)
        : await deps.store.lookupOrderSummaries(ctx.tenant.orgId, ctx.tenant.storeId, options);
    return Object.freeze({ result: Object.freeze({ orders: Object.freeze([...orders]) }) });
  };
}
