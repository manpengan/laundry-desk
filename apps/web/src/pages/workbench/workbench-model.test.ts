import assert from "node:assert/strict";
import test from "node:test";

import type { FulfillmentRowView } from "../fulfillment-model.js";
import {
  boundedCount,
  businessDayLabel,
  calendarDaysBetween,
  clockRange,
  debtAging,
  greetingFor,
  groupGarmentsByOrder,
  productionStages,
  receiptTimes,
  receivedLabel,
  rhythmView,
  segmentWidths,
  shiftBusinessDay,
  toMillis,
  versusYesterday,
  waitView,
  windowLabel,
  workbenchRole,
} from "./workbench-model.js";

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();

test("roles, greetings and business-day labels", () => {
  assert.equal(workbenchRole("admin"), "owner");
  assert.equal(workbenchRole("staff"), "clerk");
  assert.equal(greetingFor(8), "早上好");
  assert.equal(greetingFor(12), "中午好");
  assert.equal(greetingFor(15), "下午好");
  assert.equal(greetingFor(21), "晚上好");
  assert.equal(greetingFor(2), "晚上好");
  assert.equal(businessDayLabel("2026-10-18"), "10月18日 周日");
  assert.equal(businessDayLabel("2026-10-17"), "10月17日 周六");
  assert.equal(businessDayLabel("2026-02-30"), null);
  assert.equal(shiftBusinessDay("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftBusinessDay("2026-10-18", -30), "2026-09-18");
  assert.equal(shiftBusinessDay("bad", 1), null);
});

test("timestamps, calendar days and waiting labels", () => {
  assert.equal(toMillis(1_792_300_000), 1_792_300_000_000);
  assert.equal(toMillis(1_792_300_000_000), 1_792_300_000_000);
  assert.equal(calendarDaysBetween(local(17, 23, 50), local(18, 0, 10)), 1);
  assert.equal(calendarDaysBetween(local(18, 9), local(18, 20)), 0);
  const now = local(18, 15, 42);
  assert.equal(receivedLabel(local(18, 9, 5), now), "今天 09:05");
  assert.equal(receivedLabel(local(9, 9, 5), now), "10/09 收件");
  assert.deepEqual(waitView(local(18, 9), now), { label: "今天收", tone: "ok" });
  assert.deepEqual(waitView(local(16, 9), now), { label: "已 2 天", tone: "plain" });
  assert.deepEqual(waitView(local(9, 9), now), { label: "已 9 天", tone: "warn" });
  assert.equal(waitView(new Date(2026, 8, 1).getTime(), now).tone, "late");
});

test("appointment windows read as relative time", () => {
  const now = local(18, 15, 42);
  assert.equal(windowLabel(now, local(18, 17, 30), local(18, 18)), "1 小时 48 分后");
  assert.equal(windowLabel(now, local(18, 16, 0), local(18, 16, 30)), "18 分钟后");
  assert.equal(windowLabel(now, local(18, 17, 42), local(18, 18)), "2 小时后");
  assert.equal(windowLabel(now, local(18, 15, 30), local(18, 16)), "进行中");
  assert.equal(windowLabel(now, local(18, 10), local(18, 11)), "已结束");
  assert.equal(clockRange(local(18, 17, 30), local(18, 18)), "17:30–18:00");
});

test("today is compared with yesterday's whole day", () => {
  assert.equal(versusYesterday(10, null), null);
  assert.deepEqual(versusYesterday(5, 0), { fraction: null, percent: 0, label: "昨日全天无记录" });
  assert.deepEqual(versusYesterday(85, 100), {
    fraction: 0.85,
    percent: 85,
    label: "已达昨日全天 85%",
  });
  assert.equal(versusYesterday(130, 100)?.fraction, 1);
  assert.equal(versusYesterday(130, 100)?.percent, 130);
});

test("rhythm buckets orders per hour and finds the peak", () => {
  const today = [local(18, 8, 10), local(18, 10, 5), local(18, 10, 40), local(18, 15, 1)];
  const yesterday = [local(17, 9, 0), local(17, 15, 30), local(17, 16, 0), local(17, 19, 0)];
  const view = rhythmView(today, yesterday, new Date(2026, 9, 18, 15, 42));
  assert.equal(view.buckets[0]?.hour, 8);
  assert.equal(view.buckets.at(-1)?.hour, 20);
  assert.deepEqual(view.peak, { hour: 10, count: 2 });
  assert.equal(view.todayTotal, 4);
  assert.equal(view.yesterdaySoFar, 2);
  assert.equal(view.max, 2);
  assert.equal(view.buckets.find((bucket) => bucket.hour === 15)?.state, "now");
  assert.equal(view.buckets.find((bucket) => bucket.hour === 16)?.state, "future");
  assert.ok(view.nowFraction > 0.55 && view.nowFraction < 0.6);
  const early = rhythmView([local(18, 6, 30)], null, new Date(2026, 9, 18, 7, 0));
  assert.equal(early.buckets[0]?.hour, 6);
  assert.equal(early.yesterdaySoFar, null);
});

test("debt aging sums balances and tracks the oldest", () => {
  const now = local(18, 12);
  const aging = debtAging(
    [
      { balance_cents: 7600, created_at: local(9, 10) },
      { balance_cents: 4500, created_at: local(13, 10) },
      { balance_cents: 1200, created_at: local(17, 10) },
    ],
    5,
    now,
  );
  assert.deepEqual(aging, {
    count: 5,
    sumFen: 13_300,
    complete: false,
    within3: 1,
    within7: 1,
    over7: 1,
    oldestDays: 9,
  });
  assert.equal(debtAging([], 0, now).complete, true);
});

function garment(overrides: Partial<FulfillmentRowView>): FulfillmentRowView {
  return Object.freeze({
    garment_id: "g",
    order_id: "o1",
    ticket_no: "T1",
    barcode: "B",
    customer_name: null,
    customer_phone_masked: null,
    service_code: "wash",
    category_code: "shirt",
    color: null,
    brand: null,
    status: "racked",
    rack_zone: "A",
    rack_slot: "03",
    updated_at: 0,
    incident_count: 0,
    ...overrides,
  });
}

test("garments group by order with racks and an item summary", () => {
  const groups = groupGarmentsByOrder([
    garment({ garment_id: "1" }),
    garment({ garment_id: "2" }),
    garment({ garment_id: "3", category_code: "suit", rack_slot: "04" }),
    garment({
      garment_id: "4",
      order_id: "o2",
      status: "ready",
      rack_zone: null,
      rack_slot: null,
      category_code: "XS",
      service_code: "dry",
    }),
    garment({ garment_id: "5", order_id: "o2", status: "washing", rack_zone: null }),
    garment({ garment_id: "6", order_id: "o3", status: "received", rack_zone: null }),
  ]);
  assert.deepEqual(groups.get("o1"), {
    racks: ["A-03", "A-04"],
    items: "衬衫 ×2、西装 ×1",
    count: 3,
    stage: "racked",
  });
  assert.deepEqual(groups.get("o2"), {
    racks: [],
    items: "干洗 ×1、衬衫 ×1",
    count: 2,
    stage: "ready",
  });
  assert.equal(groups.get("o3")?.stage, "received");
});

test("receipt times count only the orders the day summary counts", () => {
  assert.deepEqual(
    receiptTimes([
      { status: "open", created_at: 1 },
      { status: "draft", created_at: 2 },
      { status: "closed", created_at: 3 },
      { status: "cancelled", created_at: 4 },
    ]),
    [1, 3],
  );
});

test("production stages, bounded counts and segment widths", () => {
  const stages = productionStages(100, 9, 34, 21);
  assert.deepEqual(
    stages.map((stage) => [stage.key, stage.count, stage.capped]),
    [
      ["received", 100, true],
      ["washing", 9, false],
      ["ready", 34, false],
      ["picked", 21, false],
    ],
  );
  assert.equal(boundedCount(100, true), "100+");
  assert.equal(boundedCount(9, false), "9");
  assert.deepEqual(segmentWidths([1, 1, 2]), [25, 25, 50]);
  assert.deepEqual(segmentWidths([0, 0]), [0, 0]);
});
