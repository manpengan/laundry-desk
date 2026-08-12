/**
 * Process-local order/garment/payment store for M2 skeleton (async OrderStore).
 */

import {
  buildPayPayment,
  planCollectPayment,
  planRefundPayment,
  planRepayPayment,
} from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type {
  FixedCouponDiscountInput,
  FixedCouponDiscountResult,
  GarmentRecord,
  InitialPayment,
  LedgerPaymentRow,
  OrderRecord,
  OrderStore,
  PaymentAppendInput,
  PaymentAppendResult,
  PaymentRefundAppendInput,
  PickupApplyOptions,
  PickupApplyResult,
} from "./types.js";
import { planMemoryOrderCancellation } from "./memory-order-cancel.js";
import { isGarmentAvailableAtStore } from "./garment-custody.js";
import { requireVerifiedRackBarcodes } from "./pickup-verification.js";

const key = (orgId: string, storeId: string, orderId: string): string =>
  `${orgId}|${storeId}|${orderId}`;

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly garments = new Map<string, GarmentRecord[]>();
  private readonly payments: LedgerPaymentRow[] = [];
  private readonly ticketSeq = new Map<string, number>();

  async insertOrder(
    order: OrderRecord,
    garments: readonly GarmentRecord[],
    initialPayment?: InitialPayment,
  ): Promise<void> {
    const k = key(order.org_id, order.store_id, order.order_id);
    if (this.orders.has(k)) {
      throw new Error(`Order already exists: ${order.order_id}`);
    }
    this.orders.set(k, Object.freeze({ ...order, lines: Object.freeze([...order.lines]) }));
    this.garments.set(
      k,
      garments.map((g) => Object.freeze({ ...g })),
    );
    if (initialPayment !== undefined) {
      this.payments.push(
        Object.freeze({ ...initialPayment.payment, business_date: initialPayment.business_date }),
      );
    }
  }

  async replaceDraft(
    order: OrderRecord,
    garments: readonly GarmentRecord[],
    initialPayment?: InitialPayment,
    options?: Readonly<{ requireExisting?: boolean }>,
  ): Promise<boolean> {
    const k = key(order.org_id, order.store_id, order.order_id);
    const existing = this.orders.get(k);
    if (existing === undefined && options?.requireExisting === true) return false;
    if (existing !== undefined && existing.status !== "draft") return false;
    this.orders.set(k, Object.freeze({ ...order, lines: Object.freeze([...order.lines]) }));
    this.garments.set(
      k,
      garments.map((garment) => Object.freeze({ ...garment })),
    );
    if (initialPayment !== undefined) {
      this.payments.push(
        Object.freeze({ ...initialPayment.payment, business_date: initialPayment.business_date }),
      );
    }
    return true;
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
    if (list.filter((garment) => idSet.has(garment.garment_id)).length !== idSet.size) return null;
    if (
      list.some((garment) => idSet.has(garment.garment_id) && !isGarmentAvailableAtStore(garment))
    ) {
      return null;
    }
    requireVerifiedRackBarcodes(list, garmentIds, options?.verificationBarcodes ?? []);
    const nextGarments = list.map((g) =>
      idSet.has(g.garment_id)
        ? Object.freeze({
            ...g,
            status: "picked_up" as const,
            rack_zone: null,
            rack_slot: null,
          })
        : g,
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

    if (collectCents > 0) {
      if (options?.staffId === undefined || options.staffId.length === 0) {
        throw new Error("staffId is required when collectCents > 0");
      }
      const payment = buildPayPayment({
        payment_id: options.paymentId ?? randomUUID(),
        org_id: orgId,
        store_id: storeId,
        order_id: orderId,
        amount_cents: collectCents,
        staff_id: options.staffId,
        at: nowEpoch,
        method: options.method ?? "cash",
      });
      this.payments.push(
        Object.freeze({ ...payment, business_date: options.businessDate ?? order.business_date }),
      );
    }

    return Object.freeze({ order: nextOrder, garments: Object.freeze(nextGarments) });
  }

  async listPayments(
    orgId: string,
    storeId: string,
    orderId?: string,
    limit?: number,
  ): Promise<readonly LedgerPaymentRow[]> {
    const matching = this.payments.filter(
      (p) =>
        p.org_id === orgId &&
        p.store_id === storeId &&
        (orderId === undefined || p.order_id === orderId),
    );
    return Object.freeze(limit === undefined ? matching : matching.slice(0, limit));
  }

  async appendPayment(input: PaymentAppendInput): Promise<PaymentAppendResult | null> {
    const k = key(input.org_id, input.store_id, input.order_id);
    const order = this.orders.get(k);
    if (order === undefined || order.status !== "open") return null;
    const existing = await this.listPayments(input.org_id, input.store_id, input.order_id);
    const base = {
      payment_id: randomUUID(),
      org_id: input.org_id,
      store_id: input.store_id,
      order_id: input.order_id,
      amount_cents: input.amount_cents,
      staff_id: input.staff_id,
      at: input.at,
      method: input.method,
      note: input.note,
      payable_cents: order.payable_cents,
      existing_payments: existing,
    } as const;
    const plan = input.kind === "pay" ? planCollectPayment(base) : planRepayPayment(base);
    if (!plan.ok) return null;
    const garments = this.garments.get(k) ?? [];
    const allTerminal = garments.every(
      (garment) =>
        garment.status === "picked_up" ||
        garment.status === "delivered" ||
        garment.status === "lost",
    );
    const next = Object.freeze({
      ...order,
      paid_cents: plan.paid_cents,
      balance_cents: plan.balance_cents,
      status: allTerminal && plan.balance_cents === 0 ? ("closed" as const) : ("open" as const),
      updated_at: input.at,
    });
    this.orders.set(k, next);
    const payment = Object.freeze({ ...plan.payment, business_date: input.business_date });
    this.payments.push(payment);
    return Object.freeze({ order: next, payment });
  }

  async appendRefund(input: PaymentRefundAppendInput): Promise<PaymentAppendResult | null> {
    const k = key(input.org_id, input.store_id, input.order_id);
    const order = this.orders.get(k);
    if (order === undefined || (order.status !== "open" && order.status !== "closed")) {
      return null;
    }
    const existing = await this.listPayments(input.org_id, input.store_id, input.order_id);
    const referenced = existing.find((payment) => payment.payment_id === input.ref_payment_id);
    if (referenced === undefined || referenced.method !== input.expected_method) return null;
    const plan = planRefundPayment({
      payment_id: randomUUID(),
      org_id: input.org_id,
      store_id: input.store_id,
      order_id: input.order_id,
      amount_cents: input.amount_cents,
      staff_id: input.staff_id,
      at: input.at,
      method: referenced.method,
      payable_cents: order.payable_cents,
      existing_payments: existing,
      ref_payment_id: input.ref_payment_id,
      reason: input.reason,
    });
    if (!plan.ok) return null;
    const garments = this.garments.get(k) ?? [];
    const allTerminal = garments.every(
      (garment) =>
        garment.status === "picked_up" ||
        garment.status === "delivered" ||
        garment.status === "lost",
    );
    const next = Object.freeze({
      ...order,
      paid_cents: plan.paid_cents,
      balance_cents: plan.balance_cents,
      status: allTerminal && plan.balance_cents === 0 ? ("closed" as const) : ("open" as const),
      updated_at: input.at,
    });
    const payment = Object.freeze({
      ...plan.payment,
      business_date: input.business_date,
    });
    this.orders.set(k, next);
    this.payments.push(payment);
    return Object.freeze({ order: next, payment });
  }

  async applyFixedCouponDiscount(
    input: FixedCouponDiscountInput,
  ): Promise<FixedCouponDiscountResult | null> {
    const k = key(input.org_id, input.store_id, input.order_id);
    const order = this.orders.get(k);
    if (
      order === undefined ||
      order.status !== "open" ||
      order.customer_id !== input.customer_id ||
      order.paid_cents !== 0 ||
      order.discount_cents !== 0 ||
      order.original_cents < input.min_order_cents
    ) {
      return null;
    }
    const applied = Math.min(input.discount_cents, order.original_cents);
    if (!Number.isSafeInteger(applied) || applied <= 0 || applied > order.payable_cents)
      return null;
    const next = Object.freeze({
      ...order,
      discount_cents: applied,
      payable_cents: order.payable_cents - applied,
      balance_cents: order.payable_cents - applied,
      updated_at: input.at,
    });
    this.orders.set(k, next);
    return Object.freeze({ order: next, applied_discount_cents: applied });
  }

  async cancelOpenOrder(
    orgId: string,
    storeId: string,
    orderId: string,
    reason: string,
    staffId: string,
    at: number,
    businessDate: string,
    beforeCommit?: () => Promise<void>,
  ): Promise<OrderRecord | null> {
    const k = key(orgId, storeId, orderId);
    const order = this.orders.get(k);
    const garments = this.garments.get(k);
    if (order === undefined || garments === undefined || order.status !== "open") return null;
    if (
      garments.some(
        (garment) =>
          !isGarmentAvailableAtStore(garment) ||
          garment.status === "picked_up" ||
          garment.status === "delivered",
      )
    ) {
      return null;
    }
    const existing = await this.listPayments(orgId, storeId, orderId);
    const cancellation = planMemoryOrderCancellation({
      order,
      payments: existing,
      reason,
      staffId,
      at,
      businessDate,
    });
    if (cancellation === null) return null;
    await beforeCommit?.();
    this.payments.push(...cancellation.reversals);
    this.orders.set(k, cancellation.order);
    return cancellation.order;
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
    this.payments.length = 0;
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
