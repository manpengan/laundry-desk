import assert from "node:assert/strict";
import test from "node:test";

import { createMockQueryClient } from "../../commands/query-client.js";
import { loadDebtRows } from "./workbench-loaders.js";

const row = (id: string, status: string, createdAt: number) =>
  Object.freeze({
    order_id: id,
    ticket_no: id,
    status,
    customer_phone: null,
    customer_name: null,
    payable_cents: 3_000,
    paid_cents: 1_000,
    balance_cents: 2_000,
    created_at: createdAt,
  });

function debtClient(
  byStatus: Readonly<Record<string, readonly unknown[] | null>>,
  seen: unknown[],
) {
  return createMockQueryClient(async <T = unknown>(_name: string, body?: unknown) => {
    seen.push(body);
    const filter = body as Readonly<{ status: string; offset: number; limit: number }>;
    const orders = byStatus[filter.status];
    if (orders === null || orders === undefined) {
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "RESOURCE_UNAVAILABLE" }),
      });
    }
    const result = { orders, total: orders.length, offset: filter.offset, limit: filter.limit };
    return Object.freeze({
      ok: true as const,
      data: Object.freeze({ execution: "executed", result }) as T,
    });
  });
}

test("debts read open and picked-up orders, never drafts, newest first", async () => {
  const seen: unknown[] = [];
  const rows = await loadDebtRows(
    debtClient({ open: [row("o1", "open", 300)], closed: [row("c1", "closed", 500)] }, seen),
    4,
  );
  assert.deepEqual(
    rows?.orders.map((order) => order.order_id),
    ["c1", "o1"],
  );
  assert.equal(rows?.total, 2);
  assert.deepEqual(
    seen.map((body) => (body as Readonly<{ status: string }>).status),
    ["open", "closed"],
  );
  assert.ok(
    seen.every((body) => (body as Readonly<{ min_balance_cents: number }>).min_balance_cents === 1),
  );
});

test("debts are unavailable when either half cannot be read", async () => {
  assert.equal(await loadDebtRows(debtClient({ open: [], closed: null }, []), 4), null);
});
