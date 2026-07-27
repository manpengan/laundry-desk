/**
 * Process-local stats seed map + order-backed day summary builder.
 */

import { aggregateDaySummary, emptyDaySummary, type DaySummary } from "@laundry/domain";

import type { OrderStore } from "../order/types.js";
import type { StatsDaySummaryInput, StatsQueryPort } from "./types.js";

/**
 * Optional seed map keyed by `org|store|business_date`.
 * When a seed exists it wins; otherwise order-backed computation runs (if configured).
 */
export class MemoryStatsSource implements StatsQueryPort {
  private readonly seeds = new Map<string, DaySummary>();
  private readonly orderStore: OrderStore | null;

  constructor(orderStore: OrderStore | null = null) {
    this.orderStore = orderStore;
  }

  /** Test helper: force a day summary for a tenant/date. */
  seed(orgId: string, storeId: string, summary: DaySummary): void {
    this.seeds.set(seedKey(orgId, storeId, summary.business_date), Object.freeze({ ...summary }));
  }

  clear(): void {
    this.seeds.clear();
  }

  async daySummary(input: StatsDaySummaryInput): Promise<DaySummary> {
    const key = seedKey(input.orgId, input.storeId, input.businessDate);
    const seeded = this.seeds.get(key);
    if (seeded !== undefined) {
      return seeded;
    }
    if (this.orderStore === null) {
      return emptyDaySummary(input.businessDate);
    }
    return summarizeOrdersForDay(this.orderStore, input);
  }

  async cashSummary(input: StatsDaySummaryInput): Promise<Readonly<{ cash_cents: number }>> {
    return summarizeCashForDay(this.orderStore, input);
  }
}

export function createMemoryStatsSource(orderStore: OrderStore | null = null): MemoryStatsSource {
  return new MemoryStatsSource(orderStore);
}

/** Always compute from OrderStore (no seed layer). */
export function createOrderBackedStatsQuery(orderStore: OrderStore): StatsQueryPort {
  return Object.freeze({
    daySummary: (input: StatsDaySummaryInput) => summarizeOrdersForDay(orderStore, input),
    cashSummary: (input: StatsDaySummaryInput) => summarizeCashForDay(orderStore, input),
  });
}

function seedKey(orgId: string, storeId: string, businessDate: string): string {
  return `${orgId}|${storeId}|${businessDate}`;
}

async function summarizeOrdersForDay(
  store: OrderStore,
  input: StatsDaySummaryInput,
): Promise<DaySummary> {
  if (store.listOrders === undefined) {
    return emptyDaySummary(input.businessDate);
  }

  const allOrders = await store.listOrders(input.orgId, input.storeId);
  const dayOrders = allOrders.filter((order) => order.business_date === input.businessDate);

  const garments: Array<Readonly<{ status: string }>> = [];
  for (const order of dayOrders) {
    const rows = await store.listGarments(input.orgId, input.storeId, order.order_id);
    for (const g of rows) {
      garments.push(Object.freeze({ status: g.status }));
    }
  }

  const paymentRows =
    store.listPayments === undefined
      ? Object.freeze([])
      : await store.listPayments(input.orgId, input.storeId);

  const dayPayments = paymentRows
    .filter((p) => p.kind === "pay" && p.business_date === input.businessDate)
    .map((p) => Object.freeze({ amount_cents: p.amount_cents, kind: p.kind }));

  return aggregateDaySummary({
    business_date: input.businessDate,
    orders: Object.freeze(
      dayOrders.map((o) =>
        Object.freeze({
          payable_cents: o.payable_cents,
          paid_cents: o.paid_cents,
          balance_cents: o.balance_cents,
        }),
      ),
    ),
    garments: Object.freeze(garments),
    payments: Object.freeze(dayPayments),
  });
}

async function summarizeCashForDay(
  store: OrderStore | null,
  input: StatsDaySummaryInput,
): Promise<Readonly<{ cash_cents: number }>> {
  if (store?.listPayments === undefined) return Object.freeze({ cash_cents: 0 });
  const rows = await store.listPayments(input.orgId, input.storeId);
  let total = 0;
  for (const payment of rows) {
    if (payment.method !== "cash" || payment.business_date !== input.businessDate) continue;
    const contribution =
      payment.kind === "refund" || payment.kind === "reversal"
        ? -payment.amount_cents
        : payment.amount_cents;
    total += contribution;
  }
  return Object.freeze({ cash_cents: total });
}
