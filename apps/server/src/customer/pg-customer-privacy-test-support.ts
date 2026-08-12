import assert from "node:assert/strict";

import type { PrintSnapshot } from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";

export function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

export async function waitForLock(adminPool: PgPool, backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await adminPool.query<Readonly<{ wait_event_type: string | null }>>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [backendPid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("old-phone replay did not wait on the privacy erasure lock");
}

export function printSnapshot(orderId: string, ticketNo: string): PrintSnapshot {
  return Object.freeze({
    version: 1,
    store_name: "Privacy Test Store",
    store_phone: null,
    order_id: orderId,
    ticket_no: ticketNo,
    received_at: "2026-08-01T00:00:00.000Z",
    customer_name: "Privacy Customer",
    customer_phone: "13800008888",
    note: "Call Privacy Customer on arrival",
    lines: Object.freeze([
      Object.freeze({
        line_index: 0,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 500,
        qty: 1,
        line_total_cents: 500,
        color: null,
        brand: null,
      }),
    ]),
    totals: Object.freeze({
      original_cents: 500,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      payable_cents: 500,
      paid_cents: 500,
      balance_cents: 0,
    }),
    payment_methods: Object.freeze(["cash" as const]),
  });
}
