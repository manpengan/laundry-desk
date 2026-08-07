import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryMemberStore } from "../member/memory-store.js";
import { createMemoryCustomerStore } from "./memory-store.js";
import type { CustomerRecord } from "./types.js";

const SOURCE = "c1111111-1111-4111-8111-111111111111";
const TARGET = "c2222222-2222-4222-8222-222222222222";
const STORE = "51111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "a1111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "a2222222-2222-4222-8222-222222222222";

const CUSTOMERS: readonly CustomerRecord[] = Object.freeze([
  Object.freeze({
    customer_id: SOURCE,
    phone: "13800000111",
    name: "来源",
    note: null,
    created_at: 1,
    updated_at: 1,
    merged_into_id: null,
  }),
  Object.freeze({
    customer_id: TARGET,
    phone: "13800000222",
    name: "保留",
    note: null,
    created_at: 1,
    updated_at: 1,
    merged_into_id: null,
  }),
]);

function pairedStores(seed: readonly CustomerRecord[] = CUSTOMERS) {
  const ids = [ACCOUNT_A, ACCOUNT_B];
  const member = createMemoryMemberStore({
    customerIds: [SOURCE, TARGET],
    newId: () => ids.shift() ?? "a3333333-3333-4333-8333-333333333333",
  });
  const customer = createMemoryCustomerStore(seed, member);
  return { customer, member };
}

const mergeInput = Object.freeze({
  source_customer_id: SOURCE,
  target_customer_id: TARGET,
  store_id: STORE,
  now: 100,
});

test("memory merge with no account retires the source member identity", async () => {
  const { customer, member } = pairedStores();

  assert.notEqual(await customer.merge(mergeInput), null);
  assert.deepEqual(await member.openAccount({ customer_id: SOURCE, store_id: STORE, at: 101 }), {
    ok: false,
    reason: "customer_not_found",
  });
  assert.equal(
    (await member.openAccount({ customer_id: TARGET, store_id: STORE, at: 101 })).ok,
    true,
  );
});

test("memory merge atomically relinks a source-only account to the survivor", async () => {
  const { customer, member } = pairedStores();
  const opened = await member.openAccount({ customer_id: SOURCE, store_id: STORE, at: 10 });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  assert.notEqual(await customer.merge(mergeInput), null);
  assert.equal(await member.getByCustomer(SOURCE, 10), null);
  const moved = await member.getByCustomer(TARGET, 10);
  assert.equal(moved?.account.account_id, opened.value.account.account_id);
  assert.equal(moved?.account.customer_id, TARGET);
});

test("memory merge keeps a target-only account attached to the survivor", async () => {
  const { customer, member } = pairedStores();
  const opened = await member.openAccount({ customer_id: TARGET, store_id: STORE, at: 10 });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  assert.notEqual(await customer.merge(mergeInput), null);
  assert.equal(await member.getByCustomer(SOURCE, 10), null);
  const retained = await member.getByCustomer(TARGET, 10);
  assert.equal(retained?.account.account_id, opened.value.account.account_id);
  assert.equal(retained?.account.customer_id, TARGET);
});

test("memory merge refuses two accounts without changing either store", async () => {
  const { customer, member } = pairedStores();
  await member.openAccount({ customer_id: SOURCE, store_id: STORE, at: 10 });
  await member.openAccount({ customer_id: TARGET, store_id: STORE, at: 11 });

  assert.equal(await customer.merge(mergeInput), null);
  assert.notEqual(await customer.getById(SOURCE), null);
  assert.notEqual(await customer.getById(TARGET), null);
  assert.equal((await member.getByCustomer(SOURCE, 10))?.account.customer_id, SOURCE);
  assert.equal((await member.getByCustomer(TARGET, 10))?.account.customer_id, TARGET);
});

test("memory merge refuses anonymized source or target records", async () => {
  for (const anonymizedId of [SOURCE, TARGET]) {
    const seed = CUSTOMERS.map((row) =>
      row.customer_id === anonymizedId
        ? Object.freeze({ ...row, anonymized_at: 50 })
        : Object.freeze({ ...row }),
    );
    const { customer } = pairedStores(seed);
    assert.equal(await customer.merge(mergeInput), null);
  }
});
