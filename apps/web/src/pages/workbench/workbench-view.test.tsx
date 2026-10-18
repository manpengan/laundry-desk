import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { DeliveryAppointmentView } from "../delivery-appointment-model.js";
import type { OrderListRowView } from "../OrdersList.js";
import type { DaySummaryView } from "../StatsPage.js";
import type { WorkbenchData } from "./use-workbench-data.js";
import { productionStages, rhythmView } from "./workbench-model.js";
import { WorkbenchKpis } from "./WorkbenchKpis.js";
import { WorkbenchQueue } from "./WorkbenchQueue.js";
import { AgendaCard, ProductionCard, RhythmCard } from "./WorkbenchSide.js";

const NOW = Date.now();
const DAY = 86_400_000;

const summary = (overrides: Partial<DaySummaryView> = {}): DaySummaryView =>
  Object.freeze({
    business_date: "2026-10-18",
    order_count: 26,
    garment_count: 58,
    payable_cents: 164_200,
    paid_cents: 120_000,
    balance_cents: 44_200,
    payment_cents: 130_000,
    picked_garment_count: 21,
    ...overrides,
  });

const order = (overrides: Partial<OrderListRowView>): OrderListRowView =>
  Object.freeze({
    order_id: "11111111-1111-4111-8111-111111111111",
    ticket_no: "20261016-0012",
    status: "open",
    customer_phone: "13800000981",
    customer_name: "王女士",
    payable_cents: 3_000,
    paid_cents: 3_000,
    balance_cents: 0,
    created_at: NOW - 2 * DAY,
    garment_count: 3,
    ...overrides,
  });

const data = (overrides: Partial<WorkbenchData> = {}): WorkbenchData =>
  Object.freeze({
    busy: false,
    refreshedAt: NOW,
    summary: summary({ real_income_cents: 128_600, performance_income_cents: 164_200 }),
    yesterday: summary({ real_income_cents: 151_300, performance_income_cents: 170_000 }),
    queues: Object.freeze({
      open: { orders: [order({})], total: 1 },
      overdue: { orders: [], total: 0 },
      debt: { orders: [], total: 0 },
      drafts: { orders: [], total: 0 },
    }),
    debt: Object.freeze({
      count: 7,
      sumFen: 28_600,
      complete: true,
      within3: 3,
      within7: 2,
      over7: 2,
      oldestDays: 9,
    }),
    groups: new Map(),
    stages: undefined,
    rhythm: undefined,
    appointments: undefined,
    shift: undefined,
    ...overrides,
  });

const nav = () => undefined;

test("owners read net figures against yesterday with the 账目 note", () => {
  const html = renderToStaticMarkup(<WorkbenchKpis data={data()} owner onNavigate={nav} />);
  assert.match(html, /今日实收/u);
  assert.match(html, /营业额/u);
  assert.match(html, /已达昨日全天 85%/u);
  assert.match(
    html,
    /今日实收已扣除退款与冲正，含会员充值，与账目一致；营业额按开单结算，含会员余额付款。/u,
  );
  assert.match(html, /7 单 · 最久 9 天/u);
  assert.doesNotMatch(html, /—|退款前|\sstyle=/u);
});

test("without ledger figures owners see gross payments and the gross note", () => {
  const html = renderToStaticMarkup(
    <WorkbenchKpis data={data({ summary: summary(), yesterday: null })} owner onNavigate={nav} />,
  );
  assert.match(html, /收款（退款前）/u);
  assert.match(html, /开单应收/u);
  assert.match(html, /含会员余额付款；欠款补缴和冲正请查看账目。/u);
  assert.match(html, /昨日数据暂不可用/u);
});

test("counter staff see counts, never money", () => {
  const html = renderToStaticMarkup(<WorkbenchKpis data={data()} owner={false} onNavigate={nav} />);
  assert.match(html, /未取件订单/u);
  assert.match(html, /超 30 天未取/u);
  assert.match(html, /欠款订单/u);
  assert.doesNotMatch(html, /今日实收|营业额|¥/u);
});

test("the queue masks phones, shows balances and offers the right action", () => {
  const rows = [
    order({}),
    order({
      order_id: "22222222-2222-4222-8222-222222222222",
      ticket_no: "20261011-0007",
      customer_name: "李先生",
      customer_phone: "13900001234",
      balance_cents: 4_500,
      created_at: NOW - 40 * DAY,
    }),
  ];
  const html = renderToStaticMarkup(
    <WorkbenchQueue
      data={data({
        queues: { open: { orders: rows, total: 2 }, overdue: { orders: rows, total: 2 } },
      })}
      fulfillment={false}
      tab="overdue"
      onTab={nav}
      onOpenPickup={nav}
      onNavigate={nav}
    />,
  );
  assert.match(html, /data-testid="counter-workbench-orders"/u);
  assert.match(html, /20261011-0007/u);
  assert.match(html, /138\*\*\*\*0981/u);
  assert.doesNotMatch(html, /13800000981/u);
  assert.match(html, /已付清/u);
  assert.match(html, /¥45\.00/u);
  assert.match(html, /aria-label="催取 20261011-0007"/u);
  assert.match(html, /已 40 天/u);
  assert.doesNotMatch(html, /已上架|\sstyle=/u);
});

test("picked-up debts settle in 订单与欠款 and unracked orders show their stage", () => {
  const closed = order({
    order_id: "66666666-6666-4666-8666-666666666666",
    ticket_no: "20261001-0003",
    status: "closed",
    balance_cents: 2_000,
    created_at: NOW - 17 * DAY,
  });
  const washing = order({ ticket_no: "20261018-0004", balance_cents: 1_800 });
  const html = renderToStaticMarkup(
    <WorkbenchQueue
      data={data({
        queues: { debt: { orders: [closed, washing], total: 2 } },
        groups: new Map([
          [washing.order_id, { racks: [], items: "衬衫 ×1", count: 1, stage: "washing" }],
        ]),
      })}
      fulfillment
      tab="debt"
      onTab={nav}
      onOpenPickup={nav}
      onNavigate={nav}
    />,
  );
  assert.match(html, /收欠款/u);
  assert.match(html, /已取走/u);
  assert.match(html, /data-stage="washing"[^>]*>洗涤中</u);
  assert.match(html, /衬衫 ×1/u);
});

test("drafts continue on 开单 and empty tabs explain themselves", () => {
  const drafts = renderToStaticMarkup(
    <WorkbenchQueue
      data={data({
        queues: { drafts: { orders: [order({ ticket_no: null, status: "draft" })], total: 1 } },
      })}
      fulfillment
      tab="drafts"
      onTab={nav}
      onOpenPickup={nav}
      onNavigate={nav}
    />,
  );
  assert.match(drafts, /继续开单/u);
  assert.match(drafts, />挂单</u);
  const empty = renderToStaticMarkup(
    <WorkbenchQueue
      data={data()}
      fulfillment
      tab="debt"
      onTab={nav}
      onOpenPickup={nav}
      onNavigate={nav}
    />,
  );
  assert.match(empty, /没有欠款订单/u);
  assert.match(empty, /已上架/u);
});

test("side cards draw SVG figures and hide when unavailable", () => {
  const now = new Date(2026, 9, 18, 15, 42);
  const rhythm = rhythmView(
    [now.getTime() - 60_000],
    [new Date(2026, 9, 17, 15, 41).getTime()],
    now,
  );
  const rhythmHtml = renderToStaticMarkup(<RhythmCard rhythm={rhythm} />);
  assert.match(rhythmHtml, /<svg class="ld-wb-chart"/u);
  assert.match(rhythmHtml, /<title>/u);
  assert.match(rhythmHtml, /比昨日同时段多 0 单/u);
  assert.equal(renderToStaticMarkup(<RhythmCard rhythm={null} />), "");

  const production = renderToStaticMarkup(
    <ProductionCard stages={productionStages(100, 9, 34, 21)} overdue={4} onNavigate={nav} />,
  );
  assert.match(production, /100\+/u);
  assert.match(production, /超 30 天未取 4 单/u);
  assert.doesNotMatch(production, /\sstyle=/u);

  const start = Math.floor(NOW / 1000) + 3_600;
  const appointment = Object.freeze({
    appointment_id: "33333333-3333-4333-8333-333333333333",
    customer_id: "44444444-4444-4444-8444-444444444444",
    address_id: "55555555-5555-4555-8555-555555555555",
    direction: "pickup",
    service_area_code: "A1",
    scheduled_start_at: start,
    scheduled_end_at: start + 1_800,
    fee_cents: 0,
    status: "scheduled",
    version: 1,
    policy_version: 1,
    created_at: start - 7_200,
    updated_at: start - 7_200,
    cancelled_at: null,
    cancellation_reason: null,
  }) as unknown as DeliveryAppointmentView;
  const agenda = renderToStaticMarkup(
    <AgendaCard appointments={[appointment]} shift="open" onNavigate={nav} />,
  );
  assert.match(agenda, /上门取件/u);
  assert.match(agenda, /今日预约 1 · 还剩 1/u);
  assert.match(agenda, /尚未日结交班/u);
  assert.equal(
    renderToStaticMarkup(<AgendaCard appointments={null} shift={null} onNavigate={nav} />),
    "",
  );
});
