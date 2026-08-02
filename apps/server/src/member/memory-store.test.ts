import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryMemberStore } from "./memory-store.js";
import type { MemberStore } from "./types.js";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER_CUSTOMER = "22222222-2222-4222-8222-222222222222";
const STORE_A = "33333333-3333-4333-8333-333333333333";
const STORE_B = "44444444-4444-4444-8444-444444444444";
const STAFF = "55555555-5555-4555-8555-555555555555";
const ORDER = "66666666-6666-4666-8666-666666666666";

function makeStore(): { store: MemberStore; ids: () => number } {
  let counter = 0;
  const store = createMemoryMemberStore({
    customerIds: [CUSTOMER, OTHER_CUSTOMER],
    newId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
  });
  return { store, ids: () => counter };
}

async function openAndTopup(store: MemberStore, amountCents: number): Promise<string> {
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const accountId = opened.value.account.account_id;
  const topped = await store.topup({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: amountCents,
    tender: "cash",
    staff_id: STAFF,
    at: 1001,
    business_date: "2026-08-01",
    note: null,
  });
  assert.equal(topped.ok, true);
  return accountId;
}

test("openAccount refuses a customer that does not exist", async () => {
  const { store } = makeStore();

  const outcome = await store.openAccount({
    customer_id: "99999999-9999-4999-8999-999999999999",
    store_id: STORE_A,
    at: 1000,
  });

  assert.deepEqual(outcome, { ok: false, reason: "customer_not_found" });
});

test("openAccount is idempotent per customer", async () => {
  const { store } = makeStore();

  const first = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  const second = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_B, at: 2000 });

  assert.equal(first.ok && first.value.created, true);
  assert.equal(second.ok && second.value.created, false);
  assert.equal(
    first.ok && second.ok && first.value.account.account_id === second.value.account.account_id,
    true,
  );
});

test("a fresh account starts at a zero balance", async () => {
  const { store } = makeStore();
  await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });

  const view = await store.getByCustomer(CUSTOMER, 10);

  assert.equal(view?.balance.total_cents, 0);
  assert.deepEqual(view?.recent, []);
});

test("topup raises the balance and records principal only in the first slice", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 10_000);

  const view = await store.getByCustomer(CUSTOMER, 10);

  assert.equal(view?.account.account_id, accountId);
  assert.deepEqual(view?.balance, {
    principal_cents: 10_000,
    bonus_cents: 0,
    total_cents: 10_000,
  });
  assert.equal(view?.recent.length, 1);
  assert.equal(view?.recent[0]?.kind, "topup");
  assert.equal(view?.recent[0]?.bonus_delta_cents, 0);
});

test("topup refuses a zero or negative amount", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 10_000);

  for (const amount of [0, -1, 1.5]) {
    const outcome = await store.topup({
      account_id: accountId,
      store_id: STORE_A,
      amount_cents: amount,
      tender: "cash",
      staff_id: STAFF,
      at: 1002,
      business_date: "2026-08-01",
      note: null,
    });
    assert.deepEqual(outcome, { ok: false, reason: "invalid_amount" }, `amount ${amount}`);
  }
});

test("topup and spend on an unknown account are refused", async () => {
  const { store } = makeStore();

  const outcome = await store.topup({
    account_id: "88888888-8888-4888-8888-888888888888",
    store_id: STORE_A,
    amount_cents: 100,
    tender: "cash",
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.deepEqual(outcome, { ok: false, reason: "account_not_found" });
});

test("spend debits the balance and names the order it settled", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 10_000);

  const spent = await store.spend({
    account_id: accountId,
    store_id: STORE_B,
    order_id: ORDER,
    amount_cents: 4_200,
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(spent.ok, true);
  if (!spent.ok) return;
  assert.equal(spent.value.balance.total_cents, 5_800);
  assert.equal(spent.value.principal_delta_cents, -4_200);

  const view = await store.getByCustomer(CUSTOMER, 10);
  assert.equal(view?.recent[0]?.kind, "pay");
  assert.equal(view?.recent[0]?.order_id, ORDER);
  // Spent at a different store than the top-up: the balance is org-wide and the
  // row records where it moved (ADR-17 §2).
  assert.equal(view?.recent[0]?.store_id, STORE_B);
});

test("spend refuses to overdraw by a single fen", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 1_000);

  const outcome = await store.spend({
    account_id: accountId,
    store_id: STORE_A,
    order_id: ORDER,
    amount_cents: 1_001,
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.deepEqual(outcome, { ok: false, reason: "insufficient_balance" });
  const view = await store.getByCustomer(CUSTOMER, 10);
  // A refused spend must leave no trace on an append-only ledger.
  assert.equal(view?.balance.total_cents, 1_000);
  assert.equal(view?.recent.length, 1);
});

test("repeated spends cannot drive the balance below zero", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 1_000);

  for (let index = 0; index < 5; index += 1) {
    await store.spend({
      account_id: accountId,
      store_id: STORE_A,
      order_id: ORDER,
      amount_cents: 300,
      staff_id: STAFF,
      at: 1002 + index,
      business_date: "2026-08-01",
      note: null,
    });
  }

  const view = await store.getByCustomer(CUSTOMER, 20);
  assert.equal(view?.balance.total_cents, 100);
  assert.ok((view?.balance.total_cents ?? -1) >= 0);
});

test("the balance always equals the sum of the ledger it exposes", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 10_000);
  await store.spend({
    account_id: accountId,
    store_id: STORE_A,
    order_id: ORDER,
    amount_cents: 2_500,
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  const view = await store.getByCustomer(CUSTOMER, 50);
  const summed = (view?.recent ?? []).reduce(
    (total, row) => total + row.principal_delta_cents + row.bonus_delta_cents,
    0,
  );

  assert.equal(summed, view?.balance.total_cents);
});

test("getByCustomer returns null for a customer without an account", async () => {
  const { store } = makeStore();

  assert.equal(await store.getByCustomer(OTHER_CUSTOMER, 10), null);
});

test("getByCustomer returns the newest rows first and honours the limit", async () => {
  const { store } = makeStore();
  const accountId = await openAndTopup(store, 10_000);
  for (let index = 0; index < 3; index += 1) {
    await store.topup({
      account_id: accountId,
      store_id: STORE_A,
      amount_cents: 100,
      tender: "cash",
      staff_id: STAFF,
      at: 2000 + index,
      business_date: "2026-08-01",
      note: `n${index}`,
    });
  }

  const view = await store.getByCustomer(CUSTOMER, 2);

  assert.equal(view?.recent.length, 2);
  assert.equal(view?.recent[0]?.note, "n2");
  assert.equal(view?.recent[1]?.note, "n1");
});

test("cash top-ups sum per store-day; other tenders and bonus stay out (ADR-22 §1.2)", async () => {
  const { store } = makeStore();
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const accountId = opened.value.account.account_id;

  const topup = async (
    amountCents: number,
    tender: "cash" | "wechat",
    businessDate: string,
    storeId: string = STORE_A,
  ): Promise<void> => {
    const result = await store.topup({
      account_id: accountId,
      store_id: storeId,
      amount_cents: amountCents,
      tender,
      staff_id: STAFF,
      at: 1001,
      business_date: businessDate,
      note: null,
    });
    assert.equal(result.ok, true);
  };

  await topup(100_000, "cash", "2026-08-01");
  await topup(50_000, "wechat", "2026-08-01");
  await topup(7_000, "cash", "2026-08-02");
  await topup(3_000, "cash", "2026-08-01", STORE_B);

  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-01"), 100_000);
  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-02"), 7_000);
  assert.equal(await store.sumCashPrincipal(STORE_B, "2026-08-01"), 3_000);
  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-03"), 0);
});

test("balance spend never moves cash: it carries no tender (ADR-18 §1, ADR-22 §1.1)", async () => {
  const { store } = makeStore();
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const accountId = opened.value.account.account_id;
  await store.topup({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    staff_id: STAFF,
    at: 1001,
    business_date: "2026-08-01",
    note: null,
  });

  const spent = await store.spend({
    account_id: accountId,
    store_id: STORE_A,
    order_id: ORDER,
    amount_cents: 40_000,
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });
  assert.equal(spent.ok, true);

  // The spend must not reduce the day's cash: that money entered on top-up day.
  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-01"), 100_000);
  const view = await store.getByCustomer(CUSTOMER, 10);
  const payRow = view?.recent.find((row) => row.kind === "pay");
  assert.equal(payRow?.tender, null);
});

test("a top-up grants the matching tier and snapshots which rule applied (ADR-22 §3)", async () => {
  const { store } = makeStore();
  const rule = await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "active",
    staff_id: STAFF,
    at: 900,
    note: null,
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) throw new Error("unreachable");

  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const topped = await store.topup({
    account_id: opened.value.account.account_id,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    staff_id: STAFF,
    at: 1001,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(topped.ok, true);
  if (!topped.ok) throw new Error("unreachable");
  assert.equal(topped.value.principal_delta_cents, 100_000);
  assert.equal(topped.value.bonus_delta_cents, 10_000);
  assert.deepEqual(topped.value.balance, {
    principal_cents: 100_000,
    bonus_cents: 10_000,
    total_cents: 110_000,
  });

  const view = await store.getByCustomer(CUSTOMER, 1);
  assert.equal(view?.recent[0]?.bonus_rule_id, rule.value.rule_id);
  // Only the principal is cash: the bonus put no banknote in the drawer.
  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-01"), 100_000);
});

test("retiring a tier stops new grants but never re-values past top-ups", async () => {
  const { store } = makeStore();
  const created = await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "active",
    staff_id: STAFF,
    at: 900,
    note: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const accountId = opened.value.account.account_id;
  const before = await store.topup({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    staff_id: STAFF,
    at: 1001,
    business_date: "2026-08-01",
    note: null,
  });
  assert.equal(before.ok, true);

  const retired = await store.upsertBonusRule({
    rule_id: created.value.rule_id,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "retired",
    staff_id: STAFF,
    at: 1002,
    note: null,
  });
  assert.equal(retired.ok, true);

  const after = await store.topup({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    staff_id: STAFF,
    at: 1003,
    business_date: "2026-08-01",
    note: null,
  });
  assert.equal(after.ok, true);
  if (!after.ok) throw new Error("unreachable");
  assert.equal(after.value.bonus_delta_cents, 0);

  // The earlier top-up keeps the bonus it was granted at the time.
  const view = await store.getByCustomer(CUSTOMER, 10);
  assert.equal(view?.recent[1]?.bonus_delta_cents, 10_000);
  assert.equal(view?.recent[1]?.bonus_rule_id, created.value.rule_id);
  assert.equal(view?.balance.bonus_cents, 10_000);

  const active = await store.listBonusRules(false);
  assert.equal(active.length, 0);
  const all = await store.listBonusRules(true);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "retired");
});

test("a spend eats the bonus first, leaving principal refundable (ADR-22 §4.2)", async () => {
  const { store } = makeStore();
  const rule = await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "active",
    staff_id: STAFF,
    at: 900,
    note: null,
  });
  assert.equal(rule.ok, true);
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const accountId = opened.value.account.account_id;
  await store.topup({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    staff_id: STAFF,
    at: 1001,
    business_date: "2026-08-01",
    note: null,
  });

  const spent = await store.spend({
    account_id: accountId,
    store_id: STORE_A,
    order_id: ORDER,
    amount_cents: 10_000,
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(spent.ok, true);
  if (!spent.ok) throw new Error("unreachable");
  // Bonus first: the refundable principal stays whole for longer.
  assert.deepEqual(spent.value.balance, {
    principal_cents: 100_000,
    bonus_cents: 0,
    total_cents: 100_000,
  });
});

async function accountWithBonusTopup(store: MemberStore): Promise<string> {
  const rule = await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "active",
    staff_id: STAFF,
    at: 900,
    note: null,
  });
  assert.equal(rule.ok, true);
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE_A, at: 1000 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const accountId = opened.value.account.account_id;
  const topped = await store.topup({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    staff_id: STAFF,
    at: 1001,
    business_date: "2026-08-01",
    note: null,
  });
  assert.equal(topped.ok, true);
  return accountId;
}

test("a refund returns principal only and never the bonus (ADR-22 §4.1)", async () => {
  const { store } = makeStore();
  const accountId = await accountWithBonusTopup(store);

  const refunded = await store.refund({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    reason: "顾客退卡",
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(refunded.ok, true);
  if (!refunded.ok) throw new Error("unreachable");
  assert.equal(refunded.value.principal_delta_cents, -100_000);
  assert.equal(refunded.value.bonus_delta_cents, 0);
  // The bonus survives the refund as an un-withdrawable book balance.
  assert.deepEqual(refunded.value.balance, {
    principal_cents: 0,
    bonus_cents: 10_000,
    total_cents: 10_000,
  });
});

test("a refund cannot exceed the remaining principal, bonus included or not", async () => {
  const { store } = makeStore();
  const accountId = await accountWithBonusTopup(store);

  // Total balance is 110_000, but only 100_000 of it is principal.
  const tooMuch = await store.refund({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_001,
    tender: "cash",
    reason: "顾客退卡",
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.deepEqual(tooMuch, { ok: false, reason: "insufficient_balance" });
});

test("a spend first, then a refund, returns exactly the untouched principal (ADR-22 §4.2)", async () => {
  const { store } = makeStore();
  const accountId = await accountWithBonusTopup(store);
  const spent = await store.spend({
    account_id: accountId,
    store_id: STORE_A,
    order_id: ORDER,
    amount_cents: 10_000,
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });
  assert.equal(spent.ok, true);

  // The spend ate the bonus, so the full 100_000 principal is still refundable.
  const refunded = await store.refund({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 100_000,
    tender: "cash",
    reason: "顾客退卡",
    staff_id: STAFF,
    at: 1003,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(refunded.ok, true);
  if (!refunded.ok) throw new Error("unreachable");
  assert.deepEqual(refunded.value.balance, {
    principal_cents: 0,
    bonus_cents: 0,
    total_cents: 0,
  });
});

test("a cash refund leaves the drawer by the refunded amount (ADR-22 §5.4)", async () => {
  const { store } = makeStore();
  const accountId = await accountWithBonusTopup(store);
  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-01"), 100_000);

  await store.refund({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 30_000,
    tender: "cash",
    reason: "顾客退卡",
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-01"), 70_000);
});

test("a wechat refund does not touch the drawer", async () => {
  const { store } = makeStore();
  const accountId = await accountWithBonusTopup(store);

  await store.refund({
    account_id: accountId,
    store_id: STORE_A,
    amount_cents: 30_000,
    tender: "wechat",
    reason: "原路退回",
    staff_id: STAFF,
    at: 1002,
    business_date: "2026-08-01",
    note: null,
  });

  assert.equal(await store.sumCashPrincipal(STORE_A, "2026-08-01"), 100_000);
});
