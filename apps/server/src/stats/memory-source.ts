/**
 * Process-local stats seed map + order-backed day summary builder.
 */

import {
  aggregateDaySummary,
  emptyDaySummary,
  utcDateKeyFromEpoch,
  type DaySummary,
} from "@laundry/domain";

import type { OrderStore } from "../order/types.js";
import type { PaymentStore } from "../payment/types.js";
import type { StatsDaySummaryInput, StatsQueryPort } from "./types.js";

/**
 * Optional seed map keyed by `org|store|business_date`.
 * When a seed exists it wins; otherwise order-backed computation runs (if configured).
 */
export class MemoryStatsSource implements StatsQueryPort {
  private readonly seeds = new Map<string, DaySummary>();
  private readonly orderStore: OrderStore | null;
  private readonly paymentStore: PaymentStore | null;

  constructor(orderStore: OrderStore | null = null, paymentStore: PaymentStore | null = null) {
    this.orderStore = orderStore;
    this.paymentStore = paymentStore;
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
    return summarizeOrdersForDay(this.orderStore, input, this.paymentStore);
  }
}

export function createMemoryStatsSource(
  orderStore: OrderStore | null = null,
  paymentStore: PaymentStore | null = null,
): MemoryStatsSource {
  return new MemoryStatsSource(orderStore, paymentStore);
}

/** Always compute from OrderStore (no seed layer). */
export function createOrderBackedStatsQuery(
  orderStore: OrderStore,
  paymentStore: PaymentStore | null = null,
): StatsQueryPort {
  return Object.freeze({
    daySummary: (input: StatsDaySummaryInput) =>
      summarizeOrdersForDay(orderStore, input, paymentStore),
  });
}

function seedKey(orgId: string, storeId: string, businessDate: string): string {
  return `${orgId}|${storeId}|${businessDate}`;
}

async function summarizeOrdersForDay(
  store: OrderStore,
  input: StatsDaySummaryInput,
  paymentStore: PaymentStore | null,
): Promise<DaySummary> {
  if (store.listOrders === undefined) {
    return emptyDaySummary(input.businessDate);
  }

  const allOrders = await store.listOrders(input.orgId, input.storeId);
  const dayOrders = allOrders.filter(
    (order) => utcDateKeyFromEpoch(order.created_at) === input.businessDate,
  );

  const garments: Array<Readonly<{ status: string }>> = [];
  for (const order of dayOrders) {
    const rows = await store.listGarments(input.orgId, input.storeId, order.order_id);
    for (const g of rows) {
      garments.push(Object.freeze({ status: g.status }));
    }
  }

  const paymentRows =
    paymentStore === null
      ? store.listPayments === undefined
        ? Object.freeze([])
        : await store.listPayments(input.orgId, input.storeId)
      : await listPaymentRowsForStore(paymentStore, allOrders, input);

  const dayPayments = paymentRows
    .filter((p) => p.kind === "pay" && utcDateKeyFromEpoch(p.at) === input.businessDate)
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

async function listPaymentRowsForStore(
  store: PaymentStore,
  orders: readonly Readonly<{ order_id: string }>[],
  input: StatsDaySummaryInput,
) {
  const rows = await Promise.all(
    orders.map((order) => store.listPayments(input.orgId, input.storeId, order.order_id)),
  );
  return Object.freeze(rows.flat());
}
