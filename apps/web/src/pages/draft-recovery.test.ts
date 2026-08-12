import assert from "node:assert/strict";
import test from "node:test";

import { recoverDraftForm } from "./draft-recovery.js";
import type { OrderGetResult } from "./order-read-model.js";

const DRAFT: OrderGetResult = Object.freeze({
  order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  customer_id: null,
  ticket_no: null,
  pickup_code: null,
  status: "draft",
  customer_phone: "13800000111",
  customer_name: "挂单顾客",
  note: "晚点回来",
  subtotal_cents: 1700,
  original_cents: 1500,
  discount_cents: 100,
  customer_profile_version: 0,
  discount_source: "manual",
  discount_bps: 0,
  membership_version: null,
  tier: null,
  waivers: Object.freeze({
    skip_ticket_print: false,
    skip_label_print: false,
    skip_rack_assignment: false,
  }),
  addon_cents: 200,
  urgent_cents: 100,
  freight_cents: 0,
  pricing_policy_version: 2,
  urgent_selected: true,
  freight_selected: false,
  payable_cents: 1700,
  paid_cents: 0,
  balance_cents: 1700,
  lines: Object.freeze([
    Object.freeze({
      line_index: 0,
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 1500,
      qty: 1,
      line_total_cents: 1500,
      color: "白",
      brand: "甲牌",
      garments: Object.freeze([
        Object.freeze({
          color: "白",
          brand: "甲牌",
          defects: Object.freeze(["袖口污渍"]),
          accessories: Object.freeze(["腰带"]),
          note: "单独去渍",
          addons: Object.freeze([
            Object.freeze({ code: "stain", name: "去渍", unit_price_cents: 200 }),
          ]),
        }),
      ]),
    }),
  ]),
  garments: Object.freeze([]),
});

test("recoverDraftForm restores the full editable per-piece snapshot", () => {
  const result = recoverDraftForm(DRAFT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.draft_id, DRAFT.order_id);
  assert.equal(result.value.customer_phone, "13800000111");
  assert.equal(result.value.discount_cents, "100");
  assert.equal(result.value.urgent, true);
  assert.deepEqual(result.value.lines[0]?.garments[0], {
    key: `draft-${DRAFT.order_id}-line-0-piece-0`,
    color: "白",
    brand: "甲牌",
    defects_text: "袖口污渍",
    accessories_text: "腰带",
    note: "单独去渍",
    addon_codes: ["stain"],
  });
});

test("recoverDraftForm rejects a draft that has already become a formal order", () => {
  const opened = Object.freeze({ ...DRAFT, status: "open", ticket_no: "20260811-0001" });
  const result = recoverDraftForm(opened);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /状态已变化/u);
});

test("recoverDraftForm rejects a financially stale draft snapshot", () => {
  const stale = Object.freeze({ ...DRAFT, balance_cents: DRAFT.payable_cents - 1 });
  const result = recoverDraftForm(stale);
  assert.equal(result.ok, false);
});
