import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryMemberStore } from "../member/memory-store.js";
import type { MemberStore, MemberTender } from "../member/types.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createMemoryOrderStore } from "../order/memory-store.js";

import { createOrderBackedStatsQuery } from "./memory-source.js";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const STAFF = "55555555-5555-4555-8555-555555555555";
const BUSINESS_DATE = "2026-08-01";

async function memberStoreWithTopups(
  movements: readonly Readonly<{ amount: number; tender: MemberTender; date?: string }>[],
): Promise<MemberStore> {
  const store = createMemoryMemberStore({ customerIds: [CUSTOMER] });
  const opened = await store.openAccount({
    customer_id: CUSTOMER,
    store_id: DEMO_STORE_ID,
    at: 1000,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  for (const movement of movements) {
    const result = await store.topup({
      account_id: opened.value.account.account_id,
      store_id: DEMO_STORE_ID,
      amount_cents: movement.amount,
      tender: movement.tender,
      staff_id: STAFF,
      at: 1001,
      business_date: movement.date ?? BUSINESS_DATE,
      note: null,
    });
    assert.equal(result.ok, true);
  }
  return store;
}

const dayInput = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  businessDate: BUSINESS_DATE,
});

test("cash top-ups reach the day's expected cash (ADR-18 §3, ADR-22 §1.2)", async () => {
  const memberStore = await memberStoreWithTopups([{ amount: 100_000, tender: "cash" }]);
  const stats = createOrderBackedStatsQuery(createMemoryOrderStore(), memberStore);

  const cash = await stats.cashSummary(dayInput);

  // The drawer really holds this money; before ADR-22 §1 it was invisible here
  // and every cash top-up produced an unexplained shift surplus.
  assert.equal(cash.cash_cents, 100_000);
});

test("non-cash top-ups stay out of expected cash", async () => {
  const memberStore = await memberStoreWithTopups([
    { amount: 50_000, tender: "wechat" },
    { amount: 20_000, tender: "alipay" },
    { amount: 10_000, tender: "other" },
  ]);
  const stats = createOrderBackedStatsQuery(createMemoryOrderStore(), memberStore);

  const cash = await stats.cashSummary(dayInput);

  assert.equal(cash.cash_cents, 0);
});

test("a cash top-up on another business day does not move today's cash", async () => {
  const memberStore = await memberStoreWithTopups([
    { amount: 100_000, tender: "cash", date: "2026-07-31" },
    { amount: 3_000, tender: "cash" },
  ]);
  const stats = createOrderBackedStatsQuery(createMemoryOrderStore(), memberStore);

  const cash = await stats.cashSummary(dayInput);

  assert.equal(cash.cash_cents, 3_000);
});

test("stats without a member store keep working and report only order cash", async () => {
  const stats = createOrderBackedStatsQuery(createMemoryOrderStore());

  const cash = await stats.cashSummary(dayInput);

  assert.equal(cash.cash_cents, 0);
});
