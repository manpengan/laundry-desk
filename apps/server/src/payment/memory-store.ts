import type { PaymentRow } from "@laundry/domain";

import type { PaymentStore } from "./types.js";

/** Test/demo implementation; production uses createPgPaymentStore. */
export class MemoryPaymentStore implements PaymentStore {
  private readonly rows: PaymentRow[] = [];

  async listPayments(
    orgId: string,
    storeId: string,
    orderId: string,
  ): Promise<readonly PaymentRow[]> {
    return Object.freeze(
      this.rows.filter(
        (row) => row.org_id === orgId && row.store_id === storeId && row.order_id === orderId,
      ),
    );
  }

  async appendPayment(payment: PaymentRow): Promise<void> {
    if (this.rows.some((row) => row.payment_id === payment.payment_id)) {
      throw new Error(`Duplicate payment id: ${payment.payment_id}`);
    }
    this.rows.push(Object.freeze({ ...payment }));
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export function createMemoryPaymentStore(): MemoryPaymentStore {
  return new MemoryPaymentStore();
}
