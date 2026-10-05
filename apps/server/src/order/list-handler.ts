/** Store-scoped, bounded order history; paging preserves access to old settled orders. */
import { createCommandError, OrderListInputSchema } from "@laundry/contracts";
import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { OrderHandlerDeps } from "./deps.js";
import type { OrderListSummary, OrderListSummaryOptions, OrderRecord } from "./types.js";

function matches(order: OrderRecord, options: OrderListSummaryOptions): boolean {
  if (options.status !== undefined && order.status !== options.status) return false;
  if (options.businessDate !== undefined && order.business_date !== options.businessDate)
    return false;
  if (options.customerPhone !== undefined && order.customer_phone !== options.customerPhone)
    return false;
  if (options.customerId !== undefined && order.customer_id !== options.customerId) return false;
  if (options.ticketNo !== undefined && order.ticket_no !== options.ticketNo) return false;
  if (options.minBalanceCents !== undefined && order.balance_cents < options.minBalanceCents)
    return false;
  if (options.dateFrom !== undefined && order.business_date < options.dateFrom) return false;
  if (options.dateTo !== undefined && order.business_date > options.dateTo) return false;
  const query = options.customerQuery?.toLowerCase();
  return (
    query === undefined ||
    (order.customer_name ?? "").toLowerCase().includes(query) ||
    (order.customer_phone ?? "").includes(query)
  );
}

export function listHandler(deps: OrderHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = OrderListInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const input = parsed.data;
    if (
      input.date_from !== undefined &&
      input.date_to !== undefined &&
      input.date_from > input.date_to
    ) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const options: OrderListSummaryOptions = Object.freeze({
      ...(input.business_date === undefined ? {} : { businessDate: input.business_date }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.customer_phone === undefined ? {} : { customerPhone: input.customer_phone }),
      ...(input.min_balance_cents === undefined
        ? {}
        : { minBalanceCents: input.min_balance_cents }),
      ...(input.customer_id === undefined ? {} : { customerId: input.customer_id }),
      ...(input.ticket_no === undefined ? {} : { ticketNo: input.ticket_no }),
      ...(input.customer_query === undefined ? {} : { customerQuery: input.customer_query }),
      ...(input.date_from === undefined ? {} : { dateFrom: input.date_from }),
      ...(input.date_to === undefined ? {} : { dateTo: input.date_to }),
      ...(input.ready_for_pickup === undefined ? {} : { readyForPickup: input.ready_for_pickup }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      limit: input.limit ?? 20,
    });
    const extended =
      input.offset !== undefined ||
      input.customer_id !== undefined ||
      input.ticket_no !== undefined ||
      input.customer_query !== undefined ||
      input.date_from !== undefined ||
      input.date_to !== undefined ||
      input.ready_for_pickup !== undefined;
    if (extended && deps.store.listOrderPage !== undefined) {
      const page = await deps.store.listOrderPage(ctx.tenant.orgId, ctx.tenant.storeId, options);
      return {
        result: Object.freeze({ ...page, offset: input.offset ?? 0, limit: options.limit }),
      };
    }
    if (!extended && deps.store.listOrderSummaries !== undefined) {
      const orders = await deps.store.listOrderSummaries(
        ctx.tenant.orgId,
        ctx.tenant.storeId,
        options,
      );
      return { result: Object.freeze({ orders }) };
    }
    if (deps.store.listOrders === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const all = await deps.store.listOrders(ctx.tenant.orgId, ctx.tenant.storeId);
    const candidates = all
      .filter((order) => matches(order, options))
      .sort(
        (a, b) =>
          b.created_at - a.created_at ||
          (b.ticket_no ?? "").localeCompare(a.ticket_no ?? "") ||
          b.order_id.localeCompare(a.order_id),
      );
    const filtered = [];
    for (const order of candidates) {
      if (options.readyForPickup !== undefined) {
        const garments = await deps.store.listGarments(
          ctx.tenant.orgId,
          ctx.tenant.storeId,
          order.order_id,
        );
        if (garments.some((garment) => garment.status === "racked") !== options.readyForPickup)
          continue;
      }
      filtered.push(order);
    }
    const offset = input.offset ?? 0;
    const rows: OrderListSummary[] = [];
    for (const order of filtered.slice(offset, offset + options.limit)) {
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
    return {
      result: Object.freeze({
        orders: Object.freeze(rows),
        total: filtered.length,
        offset,
        limit: options.limit,
      }),
    };
  };
}
