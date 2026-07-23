/**
 * Process-local order/garment/payment store for M2 skeleton (async OrderStore).
 */

import type {
  ApplyPaymentSummaryInput,
  CancelOrderInput,
  GarmentRecord,
  HoldOrderInput,
  OrderRecord,
  OrderStore,
  PickupApplyOptions,
  PickupApplyResult,
} from "./types.js";

const key = (orgId: string, storeId: string, orderId: string): string =>
  `${orgId}|${storeId}|${orderId}`;

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly garments = new Map<string, GarmentRecord[]>();
  private readonly ticketSeq = new Map<string, number>();

  async insertOrder(order: OrderRecord, garments: readonly GarmentRecord[]): Promise<void> {
    const k = key(order.org_id, order.store_id, order.order_id);
    if (this.orders.has(k)) {
      throw new Error(`Order already exists: ${order.order_id}`);
    }
    this.orders.set(k, Object.freeze({ ...order, lines: Object.freeze([...order.lines]) }));
    this.garments.set(
      k,
      garments.map((g) => Object.freeze({ ...g })),
    );
  }

  async getOrder(orgId: string, storeId: string, orderId: string): Promise<OrderRecord | null> {
    return this.orders.get(key(orgId, storeId, orderId)) ?? null;
  }

  async listOrders(orgId: string, storeId: string): Promise<readonly OrderRecord[]> {
    const prefix = `${orgId}|${storeId}|`;
    const rows: OrderRecord[] = [];
    for (const [k, order] of this.orders) {
      if (k.startsWith(prefix)) {
        rows.push(order);
      }
    }
    return Object.freeze(rows);
  }

  async listGarments(
    orgId: string,
    storeId: string,
    orderId: string,
  ): Promise<readonly GarmentRecord[]> {
    return this.garments.get(key(orgId, storeId, orderId)) ?? Object.freeze([]);
  }

  async applyPickup(
    orgId: string,
    storeId: string,
    orderId: string,
    garmentIds: readonly string[],
    collectCents: number,
    nowEpoch: number,
    options?: PickupApplyOptions,
  ): Promise<PickupApplyResult | null> {
    const k = key(orgId, storeId, orderId);
    const order = this.orders.get(k);
    const list = this.garments.get(k);
    if (order === undefined || list === undefined || order.status !== "open") return null;

    const idSet = new Set(garmentIds);
    const nextGarments = list.map((g) =>
      idSet.has(g.garment_id) ? Object.freeze({ ...g, status: "picked_up" as const }) : g,
    );
    const allPicked = nextGarments.every(
      (g) => g.status === "picked_up" || g.status === "delivered" || g.status === "lost",
    );
    const paid = order.paid_cents + collectCents;
    const balance = order.payable_cents - paid;
    const derivedStatus = allPicked && balance === 0 ? ("closed" as const) : ("open" as const);
    assertPickupPlanMatchesCurrentRows(options, balance, derivedStatus);
    const nextOrder = Object.freeze({
      ...order,
      paid_cents: paid,
      balance_cents: balance,
      status: derivedStatus,
      updated_at: nowEpoch,
    });
    this.orders.set(k, nextOrder);
    this.garments.set(k, nextGarments);

    return Object.freeze({ order: nextOrder, garments: Object.freeze(nextGarments) });
  }

  async applyPaymentSummary(input: ApplyPaymentSummaryInput): Promise<boolean> {
    const k = key(input.orgId, input.storeId, input.orderId);
    const order = this.orders.get(k);
    if (
      order === undefined ||
      order.status !== "open" ||
      order.paid_cents !== input.expectedPaidCents ||
      order.balance_cents !== input.expectedBalanceCents
    ) {
      return false;
    }
    this.orders.set(
      k,
      Object.freeze({
        ...order,
        paid_cents: input.paidCents,
        balance_cents: input.balanceCents,
        status: input.nextStatus,
        updated_at: input.nowEpoch,
      }),
    );
    return true;
  }

  async holdOrder(input: HoldOrderInput): Promise<boolean> {
    const k = key(input.orgId, input.storeId, input.orderId);
    const order = this.orders.get(k);
    if (order === undefined || order.status !== "open") return false;
    this.orders.set(
      k,
      Object.freeze({
        ...order,
        hold_reason: input.reason,
        held_at: input.nowEpoch,
        held_by_staff_id: input.staffId,
        updated_at: input.nowEpoch,
      }),
    );
    return true;
  }

  async cancelOrder(input: CancelOrderInput): Promise<boolean> {
    const k = key(input.orgId, input.storeId, input.orderId);
    const order = this.orders.get(k);
    if (
      order === undefined ||
      order.status !== "open" ||
      order.paid_cents !== input.expectedPaidCents ||
      order.balance_cents !== input.expectedBalanceCents
    ) {
      return false;
    }
    this.orders.set(
      k,
      Object.freeze({
        ...order,
        status: "cancelled",
        paid_cents: input.paidCents,
        balance_cents: input.balanceCents,
        hold_reason: null,
        held_at: null,
        held_by_staff_id: null,
        updated_at: input.nowEpoch,
      }),
    );
    return true;
  }

  async nextTicketSeq(orgId: string, storeId: string, dayKey: string): Promise<number> {
    const k = `${orgId}|${storeId}|${dayKey}`;
    const current = this.ticketSeq.get(k) ?? 0;
    const next = current + 1;
    this.ticketSeq.set(k, next);
    return next;
  }

  /** Test helper. */
  clear(): void {
    this.orders.clear();
    this.garments.clear();
    this.ticketSeq.clear();
  }
}

function assertPickupPlanMatchesCurrentRows(
  options: PickupApplyOptions | undefined,
  balanceCents: number,
  nextOrderStatus: OrderRecord["status"],
): void {
  if (options?.nextBalanceCents !== undefined && options.nextBalanceCents !== balanceCents) {
    throw new Error("Pickup plan balance no longer matches persisted order");
  }
  if (options?.nextOrderStatus !== undefined && options.nextOrderStatus !== nextOrderStatus) {
    throw new Error("Pickup plan status no longer matches persisted order");
  }
}

export function createMemoryOrderStore(): MemoryOrderStore {
  return new MemoryOrderStore();
}
