/**
 * Process-local stats seed map + order-backed day summary builder.
 */

import { aggregateDaySummary, emptyDaySummary, type DaySummary } from "@laundry/domain";

import type { MemberStore } from "../member/types.js";
import type { OrderStore } from "../order/types.js";
import { paymentNetCents } from "../reconciliation/common.js";
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

/**
 * Always compute from OrderStore (no seed layer).
 *
 * `memberStore` is optional so callers with no stored value keep the old shape;
 * when supplied, its cash top-ups join the day's expected cash (ADR-22 §1.2).
 */
export function createOrderBackedStatsQuery(
  orderStore: OrderStore,
  memberStore: MemberStore | null = null,
): StatsQueryPort {
  return Object.freeze({
    daySummary: (input: StatsDaySummaryInput) => summarizeOrdersForDay(orderStore, input),
    cashSummary: (input: StatsDaySummaryInput) =>
      summarizeCashForDay(orderStore, input, memberStore),
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
  const dayOrders = allOrders.filter(
    (order) =>
      order.business_date === input.businessDate &&
      (order.status === "open" || order.status === "closed"),
  );

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
  memberStore: MemberStore | null = null,
): Promise<Readonly<{ cash_cents: number }>> {
  return Object.freeze({
    cash_cents:
      (await orderCashForDay(store, input)) + (await memberCashForDay(memberStore, input)),
  });
}

async function orderCashForDay(
  store: OrderStore | null,
  input: StatsDaySummaryInput,
): Promise<number> {
  if (store?.listPayments === undefined) return 0;
  const rows = await store.listPayments(input.orgId, input.storeId);
  const referencedKinds = new Map(rows.map((payment) => [payment.payment_id, payment.kind]));
  let total = 0;
  for (const payment of rows) {
    if (payment.method !== "cash" || payment.business_date !== input.businessDate) continue;
    total += paymentNetCents(
      payment,
      payment.ref_payment_id === null ? undefined : referencedKinds.get(payment.ref_payment_id),
    );
  }
  return total;
}

/**
 * Cash that entered through stored value (ADR-18 §3, ADR-22 §1.2).
 *
 * A top-up never touches `payments`, so without this the banknotes a customer
 * hands over for a top-up sit in the drawer while the expected figure ignores
 * them — a shift surplus nothing on the books explains.
 */
async function memberCashForDay(
  memberStore: MemberStore | null,
  input: StatsDaySummaryInput,
): Promise<number> {
  if (memberStore === null) return 0;
  return memberStore.sumCashPrincipal(input.storeId, input.businessDate);
}
