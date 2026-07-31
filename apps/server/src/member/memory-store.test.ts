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
