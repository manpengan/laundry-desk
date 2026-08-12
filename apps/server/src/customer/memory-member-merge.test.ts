import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryMemberStore } from "../member/memory-store.js";
import { createMemoryCustomerStore } from "./memory-store.js";
import type { CustomerMemberAccountMergePort, CustomerRecord } from "./types.js";

const SOURCE = "c1111111-1111-4111-8111-111111111111";
const TARGET = "c2222222-2222-4222-8222-222222222222";
const FINAL_TARGET = "c3333333-3333-4333-8333-333333333333";
const STORE = "51111111-1111-4111-8111-111111111111";
const STAFF = "71111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "a1111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "a2222222-2222-4222-8222-222222222222";

const CUSTOMERS: readonly CustomerRecord[] = Object.freeze([
  Object.freeze({
    customer_id: SOURCE,
    phone: "13800000111",
    name: "来源",
    note: null,
    version: 1,
    created_at: 1,
    updated_at: 1,
    merged_into_id: null,
  }),
  Object.freeze({
    customer_id: TARGET,
    phone: "13800000222",
    name: "保留",
    note: null,
    version: 1,
    created_at: 1,
    updated_at: 1,
    merged_into_id: null,
  }),
]);

function groupCustomer(index: number, rootId: string): CustomerRecord {
  return Object.freeze({
    customer_id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    phone: `139${String(index).padStart(8, "0")}`,
    name: null,
    note: null,
    version: 1,
    created_at: 1,
    updated_at: 1,
    merged_into_id: rootId,
  });
}

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
  staff_id: STAFF,
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

test("memory merge rejects a combined canonical group above 1000 before member mutation", async () => {
  const sourceChildren = Array.from({ length: 499 }, (_, index) =>
    groupCustomer(index + 1, SOURCE),
  );
  const targetChildren = Array.from({ length: 500 }, (_, index) =>
    groupCustomer(index + 500, TARGET),
  );
  let memberMergeCalls = 0;
  const memberAccounts: CustomerMemberAccountMergePort = Object.freeze({
    mergeCustomerMemberAccount: () => {
      memberMergeCalls += 1;
      return "no_account";
    },
  });
  const customer = createMemoryCustomerStore(
    Object.freeze([...CUSTOMERS, ...sourceChildren, ...targetChildren]),
    memberAccounts,
  );

  assert.equal((await customer.listCanonicalGroup?.(SOURCE))?.length, 500);
  assert.equal((await customer.listCanonicalGroup?.(TARGET))?.length, 501);
  assert.equal(await customer.merge(mergeInput), null);
  assert.equal(memberMergeCalls, 0);
  assert.equal((await customer.listCanonicalGroup?.(SOURCE))?.length, 500);
  assert.equal((await customer.listCanonicalGroup?.(TARGET))?.length, 501);
  assert.equal((await customer.getById(SOURCE))?.customer_id, SOURCE);
  assert.equal((await customer.getById(TARGET))?.customer_id, TARGET);
});

test("memory privacy events remain visible through a recursive merge group", async () => {
  const finalTarget = Object.freeze({
    ...CUSTOMERS[1]!,
    customer_id: FINAL_TARGET,
    phone: "13800000333",
    name: "最终保留",
  });
  const customer = createMemoryCustomerStore(Object.freeze([...CUSTOMERS, finalTarget]));
  await customer.exportPrivacy({
    customer_id: SOURCE,
    store_id: STORE,
    staff_id: STAFF,
    reason: "customer_request",
    event_id: "e1111111-1111-4111-8111-111111111111",
    now: 10,
  });

  assert.notEqual(await customer.merge(mergeInput), null);
  assert.notEqual(
    await customer.merge({
      ...mergeInput,
      source_customer_id: TARGET,
      target_customer_id: FINAL_TARGET,
      now: 101,
    }),
    null,
  );

  for (const customerId of [SOURCE, TARGET, FINAL_TARGET]) {
    const events = await customer.listPrivacyEvents(customerId, 20);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.customer_id, SOURCE);
    assert.equal(events[0]?.reason, "customer_request");
  }
});
