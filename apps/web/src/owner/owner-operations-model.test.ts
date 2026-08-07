import assert from "node:assert/strict";
import test from "node:test";

import { createMockQueryClient } from "../commands/query-client.js";
import type { CommandResult } from "../commands/types.js";
import {
  loadOwnerDrilldown,
  loadOwnerPortfolio,
  parseOwnerDrilldown,
  parseOwnerPortfolio,
} from "./owner-operations-model.js";

const common = Object.freeze({
  business_date: "2026-08-07",
  generated_at: "2026-08-07T05:00:00.000Z",
  total_row_count: 1,
  truncated: false,
});

const pickup = Object.freeze({
  ...common,
  kind: "today_pickups",
  totals: Object.freeze({ picked_up_garment_count: 2, picked_up_order_count: 1 }),
  rows: Object.freeze([
    Object.freeze({
      ticket_no: "20260807-0001",
      picked_at: "2026-08-07T04:30:00.000Z",
      garment_count: 2,
    }),
  ]),
});

const portfolio = Object.freeze({
  generated_at: "2026-08-07T05:00:00.000Z",
  returned_store_count: 1,
  truncated: false,
  totals: Object.freeze({
    performance_income_cents: 12_300,
    real_income_cents: 10_000,
    picked_up_garment_count: 7,
    new_receivable_cents: 4_500,
    new_receivable_order_count: 2,
    overdue_garment_count: 9,
    overdue_order_count: 4,
  }),
  stores: Object.freeze([
    Object.freeze({
      store_code: "main",
      store_name: "主店",
      timezone: "Asia/Shanghai",
      business_date: "2026-08-07",
      performance_income_cents: 12_300,
      real_income_cents: 10_000,
      picked_up_garment_count: 7,
      new_receivable_cents: 4_500,
      new_receivable_order_count: 2,
      overdue_garment_count: 9,
      overdue_order_count: 4,
    }),
  ]),
});

test("owner operation parsers accept exact minimized results", () => {
  assert.deepEqual(parseOwnerDrilldown(pickup), pickup);
  assert.deepEqual(parseOwnerPortfolio(portfolio), portfolio);
});

test("owner drilldown rejects PII, bad bounds and metric drift", () => {
  assert.equal(
    parseOwnerDrilldown({
      ...pickup,
      rows: [{ ...pickup.rows[0], customer_phone: "13800000000" }],
    }),
    null,
  );
  assert.equal(parseOwnerDrilldown({ ...pickup, truncated: true }), null);
  assert.equal(
    parseOwnerDrilldown({
      ...pickup,
      total_row_count: 2,
      truncated: true,
      totals: { picked_up_garment_count: 3, picked_up_order_count: 2 },
    }),
    null,
  );
  assert.equal(
    parseOwnerDrilldown({
      ...pickup,
      totals: { picked_up_garment_count: 1, picked_up_order_count: 1 },
    }),
    null,
  );
});

test("owner portfolio rejects internal ids, total drift and loose envelopes", () => {
  assert.equal(
    parseOwnerPortfolio({
      ...portfolio,
      stores: [{ ...portfolio.stores[0], store_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }],
    }),
    null,
  );
  assert.equal(
    parseOwnerPortfolio({
      ...portfolio,
      totals: { ...portfolio.totals, real_income_cents: 9_999 },
    }),
    null,
  );
});

test("loaders send only the fixed kind or empty input and require executed envelopes", async () => {
  const calls: Array<Readonly<{ name: string; input: unknown }>> = [];
  const client = createMockQueryClient(
    async <T = unknown>(name: string, input: unknown): Promise<CommandResult<T>> => {
      calls.push(Object.freeze({ name, input }));
      return {
        ok: true,
        data: {
          execution: "executed",
          result: name.includes("portfolio") ? portfolio : pickup,
        } as T,
      };
    },
  );

  assert.equal((await loadOwnerDrilldown(client, "today_pickups")).ok, true);
  assert.equal((await loadOwnerPortfolio(client)).ok, true);
  assert.deepEqual(calls, [
    { name: "reporting.owner_dashboard.drilldown", input: { kind: "today_pickups" } },
    { name: "reporting.owner_portfolio.get", input: {} },
  ]);

  const loose = createMockQueryClient(async <T = unknown>(): Promise<CommandResult<T>> => ({
    ok: true,
    data: { result: pickup } as T,
  }));
  assert.deepEqual(await loadOwnerDrilldown(loose, "today_pickups"), {
    ok: false,
    error: "经营数据格式无效",
  });

  const inheritedEnvelope = Object.assign(Object.create({ execution: "executed" }), {
    result: pickup,
    unexpected: true,
  }) as unknown;
  const inherited = createMockQueryClient(async <T = unknown>(): Promise<CommandResult<T>> => ({
    ok: true,
    data: inheritedEnvelope as T,
  }));
  assert.deepEqual(await loadOwnerDrilldown(inherited, "today_pickups"), {
    ok: false,
    error: "经营数据格式无效",
  });
});
