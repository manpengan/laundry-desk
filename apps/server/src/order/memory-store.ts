/**
 * Process-local order/garment store for M2 skeleton (no PG yet).
 */

import type { GarmentRecord, OrderRecord, OrderStore } from "./types.js";

const key = (orgId: string, storeId: string, orderId: string): string =>
  `${orgId}|${storeId}|${orderId}`;

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly garments = new Map<string, GarmentRecord[]>();
  private readonly ticketSeq = new Map<string, number>();

  insertOrder(order: OrderRecord, garments: readonly GarmentRecord[]): void {
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

  getOrder(orgId: string, storeId: string, orderId: string): OrderRecord | null {
    return this.orders.get(key(orgId, storeId, orderId)) ?? null;
  }

  listGarments(orgId: string, storeId: string, orderId: string): readonly GarmentRecord[] {
    return this.garments.get(key(orgId, storeId, orderId)) ?? Object.freeze([]);
  }

  applyPickup(
    orgId: string,
    storeId: string,
    orderId: string,
    garmentIds: readonly string[],
    collectCents: number,
    nowEpoch: number,
  ): Readonly<{ order: OrderRecord; garments: readonly GarmentRecord[] }> | null {
    const k = key(orgId, storeId, orderId);
    const order = this.orders.get(k);
    const list = this.garments.get(k);
    if (order === undefined || list === undefined) return null;

    const idSet = new Set(garmentIds);
    const nextGarments = list.map((g) =>
      idSet.has(g.garment_id) ? Object.freeze({ ...g, status: "picked_up" as const }) : g,
    );
    const allPicked = nextGarments.every(
      (g) => g.status === "picked_up" || g.status === "delivered" || g.status === "lost",
    );
    const paid = order.paid_cents + collectCents;
    const balance = order.payable_cents - paid;
    const nextOrder = Object.freeze({
      ...order,
      paid_cents: paid,
      balance_cents: balance,
      status: allPicked && balance <= 0 ? ("closed" as const) : order.status,
      updated_at: nowEpoch,
    });
    this.orders.set(k, nextOrder);
    this.garments.set(k, nextGarments);
    return Object.freeze({ order: nextOrder, garments: Object.freeze(nextGarments) });
  }

  nextTicketSeq(orgId: string, storeId: string, dayKey: string): number {
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

export function createMemoryOrderStore(): MemoryOrderStore {
  return new MemoryOrderStore();
}
