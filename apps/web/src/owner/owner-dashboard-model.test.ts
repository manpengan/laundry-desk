import assert from "node:assert/strict";
import test from "node:test";

import type { QueryPort } from "../commands/types.js";
import {
  OWNER_DASHBOARD_QUERY_NAME,
  loadOwnerDashboard,
  parseOwnerDashboard,
  selectOwnerTrend,
  type OwnerDashboardData,
} from "./owner-dashboard-model.js";

function trendEndingAt(endDate: string) {
  const end = new Date(`${endDate}T12:00:00.000Z`);
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (29 - index));
    return Object.freeze({
      business_date: date.toISOString().slice(0, 10),
      performance_income_cents: index === 29 ? 12_300 : index * 100,
      real_income_cents: index === 29 ? 10_000 : index * 80,
    });
  });
}

const SAMPLE = Object.freeze({
  business_date: "2026-08-07",
  generated_at: "2026-08-07T05:00:00.000Z",
  overdue_min_age_days: 30,
  today: Object.freeze({
    performance_income_cents: 12_300,
    real_income_cents: 10_000,
    picked_up_garment_count: 7,
    new_receivable_cents: 4_500,
    new_receivable_order_count: 2,
    overdue_garment_count: 9,
    overdue_order_count: 4,
  }),
  trend: Object.freeze(trendEndingAt("2026-08-07")),
});

test("parseOwnerDashboard accepts and freezes the exact 30-day response", () => {
  const parsed = parseOwnerDashboard(SAMPLE);
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed, SAMPLE);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed?.today), true);
  assert.equal(Object.isFrozen(parsed?.trend), true);
  assert.equal(Object.isFrozen(parsed?.trend[0]), true);
});

test("parseOwnerDashboard fails closed on extra fields, gaps, short trends, or negatives", () => {
  assert.equal(parseOwnerDashboard({ ...SAMPLE, store_id: "client-owned" }), null);
  assert.equal(parseOwnerDashboard({ ...SAMPLE, trend: SAMPLE.trend.slice(1) }), null);
  assert.equal(
    parseOwnerDashboard({
      ...SAMPLE,
      trend: SAMPLE.trend.map((row, index) =>
        index === 10 ? { ...row, business_date: "2026-01-01" } : row,
      ),
    }),
    null,
  );
  assert.equal(
    parseOwnerDashboard({
      ...SAMPLE,
      today: { ...SAMPLE.today, picked_up_garment_count: -1 },
    }),
    null,
  );
  assert.equal(parseOwnerDashboard({ ...SAMPLE, overdue_min_age_days: 29 }), null);
  assert.equal(
    parseOwnerDashboard({
      ...SAMPLE,
      today: { ...SAMPLE.today, performance_income_cents: 12_301 },
    }),
    null,
  );
});

test("parseOwnerDashboard preserves signed income after refunds", () => {
  const trend = SAMPLE.trend.map((row, index) =>
    index === 29 ? { ...row, performance_income_cents: -300, real_income_cents: -100 } : row,
  );
  const parsed = parseOwnerDashboard({
    ...SAMPLE,
    today: {
      ...SAMPLE.today,
      performance_income_cents: -300,
      real_income_cents: -100,
    },
    trend,
  });
  assert.notEqual(parsed, null);
  assert.equal(parsed?.today.performance_income_cents, -300);
});

test("loadOwnerDashboard sends the fixed query name with a strict empty input", async () => {
  const calls: Array<Readonly<{ name: string; body: unknown }>> = [];
  const queryClient: QueryPort = Object.freeze({
    execute: async <T = unknown>(name: string, body: unknown = {}) => {
      calls.push(Object.freeze({ name, body }));
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({ execution: "executed", result: SAMPLE }) as T,
      });
    },
  });

  const outcome = await loadOwnerDashboard(queryClient);

  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, [{ name: OWNER_DASHBOARD_QUERY_NAME, body: {} }]);
  assert.deepEqual(outcome.ok ? outcome.data : null, SAMPLE);
});

test("loadOwnerDashboard exposes transport errors and rejects malformed success data", async () => {
  const denied: QueryPort = Object.freeze({
    execute: async () =>
      Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "PERMISSION_DENIED", message: "没有查看权限" }),
      }),
  });
  const malformed: QueryPort = Object.freeze({
    execute: async <T = unknown>() =>
      Object.freeze({
        ok: true as const,
        data: Object.freeze({ execution: "executed", result: { business_date: "bad" } }) as T,
      }),
  });
  const rejected: QueryPort = Object.freeze({
    execute: async () => Promise.reject(new Error("credential-bearing transport failure")),
  });

  assert.deepEqual(await loadOwnerDashboard(denied), {
    ok: false,
    error: "没有查看权限",
  });
  assert.deepEqual(await loadOwnerDashboard(malformed), {
    ok: false,
    error: "经营看板数据格式无效",
  });
  assert.deepEqual(await loadOwnerDashboard(rejected), {
    ok: false,
    error: "本地服务暂时不可用",
  });
});

test("loadOwnerDashboard requires the exact executed query envelope", async () => {
  for (const data of [
    SAMPLE,
    { result: SAMPLE },
    { execution: "preview", result: SAMPLE },
    { execution: "executed", result: SAMPLE, extra: true },
  ]) {
    const queryClient: QueryPort = Object.freeze({
      execute: async <T = unknown>() =>
        Object.freeze({ ok: true as const, data: Object.freeze(data) as T }),
    });
    assert.deepEqual(await loadOwnerDashboard(queryClient), {
      ok: false,
      error: "经营看板数据格式无效",
    });
  }
});

test("selectOwnerTrend derives seven days from the same 30-day snapshot", () => {
  const dashboard = parseOwnerDashboard(SAMPLE) as OwnerDashboardData;
  const seven = selectOwnerTrend(dashboard, 7);
  const thirty = selectOwnerTrend(dashboard, 30);

  assert.equal(seven.length, 7);
  assert.equal(seven[0]?.business_date, "2026-08-01");
  assert.equal(seven.at(-1)?.business_date, "2026-08-07");
  assert.equal(thirty.length, 30);
  assert.equal(Object.isFrozen(seven), true);
});
