/**
 * Workbench reads (ADR-100). Every panel reads existing bounded queries; a failed or
 * denied read resolves to null so its panel can say so without toasting on refresh.
 */

import type { QueryPort } from "../../commands/types.js";
import {
  parseDeliveryAppointments,
  type DeliveryAppointmentView,
} from "../delivery-appointment-model.js";
import {
  parseFulfillmentRows,
  unwrapFulfillmentResult,
  type FulfillmentRowView,
  type FulfillmentStatus,
} from "../fulfillment-model.js";
import type { OrderListRowView } from "../OrdersList.js";
import {
  parseShiftClosing,
  unwrapShiftResult,
  type ShiftClosingView,
} from "../shift-closing-view.js";
import {
  parseDaySummary,
  unwrapQueryResult as unwrapStats,
  type DaySummaryView,
} from "../StatsPage.js";
import { parseOrderPage, type OrderPage } from "../use-order-page.js";
import { PRODUCTION_PAGE, toMillis } from "./workbench-model.js";

export const QUEUE_PAGE = 20;
const LIST_PAGE = 50;

type Read = Readonly<{ data: unknown }> | null;

async function read(queryClient: QueryPort, name: string, body: unknown): Promise<Read> {
  try {
    const result = await queryClient.execute<unknown>(name, body);
    return result.ok ? Object.freeze({ data: result.data }) : null;
  } catch {
    return null;
  }
}

export async function loadDaySummary(
  queryClient: QueryPort,
  businessDate?: string,
): Promise<DaySummaryView | null> {
  const body = businessDate === undefined ? {} : { business_date: businessDate };
  const result = await read(queryClient, "stats.day.summary", body);
  return result === null ? null : parseDaySummary(unwrapStats(result.data));
}

export type OrderFilter = Readonly<Record<string, unknown>>;

export async function loadOrderPage(
  queryClient: QueryPort,
  filter: OrderFilter,
  limit: number = QUEUE_PAGE,
  offset = 0,
): Promise<OrderPage | null> {
  const result = await read(queryClient, "order.list", { ...filter, offset, limit });
  const page = result === null ? null : parseOrderPage(result.data);
  return page !== null && page.offset === offset && page.limit === limit ? page : null;
}

export type OrderRows = Readonly<{ orders: readonly OrderListRowView[]; total: number }>;

/** The first `pages` pages of a filter (newest first); `total` still counts every row. */
export async function loadOrderPages(
  queryClient: QueryPort,
  filter: OrderFilter,
  pages: number,
): Promise<OrderRows | null> {
  const first = await loadOrderPage(queryClient, filter, LIST_PAGE, 0);
  if (first === null) return null;
  const extra = Math.min(pages, Math.ceil(first.total / LIST_PAGE)) - 1;
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, extra) }, (_, index) =>
      loadOrderPage(queryClient, filter, LIST_PAGE, (index + 1) * LIST_PAGE),
    ),
  );
  const orders = [...first.orders];
  for (const page of rest) {
    if (page === null) break;
    orders.push(...page.orders);
  }
  return Object.freeze({ orders: Object.freeze(orders), total: first.total });
}

/**
 * Unpaid balances on received orders, still in store or already picked up (newest first).
 * A draft carries its whole price as balance but is not a debt, so the read never includes it.
 */
export async function loadDebtRows(
  queryClient: QueryPort,
  pages: number,
): Promise<OrderRows | null> {
  const [open, closed] = await Promise.all([
    loadOrderPages(queryClient, { status: "open", min_balance_cents: 1 }, pages),
    loadOrderPages(queryClient, { status: "closed", min_balance_cents: 1 }, pages),
  ]);
  if (open === null || closed === null) return null;
  const orders = [...open.orders, ...closed.orders].sort(
    (a, b) => toMillis(b.created_at) - toMillis(a.created_at),
  );
  return Object.freeze({ orders: Object.freeze(orders), total: open.total + closed.total });
}

export async function loadGarments(
  queryClient: QueryPort,
  statuses: readonly FulfillmentStatus[],
): Promise<readonly FulfillmentRowView[] | null> {
  const result = await read(queryClient, "fulfillment.workbench", {
    statuses,
    limit: PRODUCTION_PAGE,
  });
  return result === null ? null : parseFulfillmentRows(unwrapFulfillmentResult(result.data));
}

/** "open" = the business day is not closed yet; null = unavailable. */
export async function loadShiftClosing(
  queryClient: QueryPort,
  businessDate: string,
): Promise<ShiftClosingView | "open" | null> {
  const result = await read(queryClient, "shift.get", { business_date: businessDate });
  if (result === null) return null;
  const raw = unwrapShiftResult(result.data);
  if (raw === null || raw === undefined) return "open";
  return parseShiftClosing(raw);
}

/** Today's scheduled pickup / return appointments (epoch seconds, local calendar day). */
export async function loadTodayAppointments(
  queryClient: QueryPort,
  now: Date,
): Promise<readonly DeliveryAppointmentView[] | null> {
  const start = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000,
  );
  const result = await read(queryClient, "delivery.appointments.list", {
    status: "scheduled",
    from_start_at: start,
    to_start_at: start + 86_399,
    limit: 20,
  });
  return result === null ? null : parseDeliveryAppointments(result.data);
}
