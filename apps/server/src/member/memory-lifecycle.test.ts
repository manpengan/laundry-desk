import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryMemberStore } from "./memory-store.js";

const CUSTOMER = "customer-1";
const STORE = "store-1";
const STAFF = "staff-1";
const DAY = "2026-08-07";

function storeWithIds() {
  let sequence = 0;
  return createMemoryMemberStore({
    customerIds: [CUSTOMER],
    newId: () => `id-${++sequence}`,
  });
}

async function fundedAccount() {
  const store = storeWithIds();
  await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 1_000,
    bonus_cents: 200,
    status: "active",
    staff_id: STAFF,
    at: 1,
    note: null,
  });
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE, at: 2 });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  await store.topup({
    account_id: opened.value.account.account_id,
    store_id: STORE,
    amount_cents: 1_000,
    tender: "cash",
    staff_id: STAFF,
    at: 3,
    business_date: DAY,
    note: null,
  });
  return { store, accountId: opened.value.account.account_id };
}

test("memory lifecycle freezes, blocks money, unfreezes and prevents status ABA", async () => {
  const { store, accountId } = await fundedAccount();
  const frozen = await store.transitionStatus({
    action: "freeze",
    account_id: accountId,
    expected_customer_id: CUSTOMER,
    expected_status_version: 1,
    store_id: STORE,
    staff_id: STAFF,
    at: 4,
    reason: "reported lost",
  });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) return;
  assert.equal(frozen.value.account.status, "frozen");
  assert.equal(frozen.value.account.status_version, 2);

  const common = {
    account_id: accountId,
    store_id: STORE,
    staff_id: STAFF,
    at: 5,
    business_date: DAY,
    note: null,
  } as const;
  assert.deepEqual(await store.topup({ ...common, amount_cents: 1, tender: "cash" }), {
    ok: false,
    reason: "account_frozen",
  });
  assert.deepEqual(
    await store.refund({ ...common, amount_cents: 1, tender: "cash", reason: "no" }),
    { ok: false, reason: "account_frozen" },
  );
  assert.deepEqual(
    await store.spend({
      ...common,
      amount_cents: 1,
      order_id: "order-1",
      order_customer_id: CUSTOMER,
    }),
    {
      ok: false,
      reason: "account_frozen",
    },
  );

  assert.deepEqual(
    await store.transitionStatus({
      action: "unfreeze",
      account_id: accountId,
      expected_customer_id: CUSTOMER,
      expected_status_version: 1,
      store_id: STORE,
      staff_id: STAFF,
      at: 6,
      reason: "stale view",
    }),
    { ok: false, reason: "account_version_conflict" },
  );
  const active = await store.transitionStatus({
    action: "unfreeze",
    account_id: accountId,
    expected_customer_id: CUSTOMER,
    expected_status_version: 2,
    store_id: STORE,
    staff_id: STAFF,
    at: 7,
    reason: "identity checked",
  });
  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.equal(active.value.account.status, "active");
  assert.equal(active.value.account.status_version, 3);
});

test("memory close atomically refunds principal, forfeits bonus and becomes terminal", async () => {
  const { store, accountId } = await fundedAccount();
  const closed = await store.close({
    account_id: accountId,
    expected_customer_id: CUSTOMER,
    expected_status_version: 1,
    expected_status: "active",
    expected_principal_cents: 1_000,
    expected_bonus_cents: 200,
    refund_tender: "cash",
    store_id: STORE,
    staff_id: STAFF,
    at: 8,
    business_date: DAY,
    reason: "customer requested closure",
  });
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.value.account.status, "closed");
  assert.equal(closed.value.account.status_version, 2);
  assert.deepEqual(closed.value.balance, {
    principal_cents: 0,
    bonus_cents: 0,
    total_cents: 0,
  });
  assert.equal(closed.value.refunded_principal_cents, 1_000);
  assert.equal(closed.value.forfeited_bonus_cents, 200);
  assert.notEqual(closed.value.refund_ledger_id, null);
  assert.notEqual(closed.value.bonus_forfeit_ledger_id, null);

  const view = await store.getByCustomer(CUSTOMER, 50);
  assert.equal(view?.recent[0]?.kind, "bonus_forfeit");
  assert.equal(view?.recent[0]?.bonus_delta_cents, -200);
  assert.equal(view?.recent[0]?.tender, null);
  assert.equal(view?.recent[1]?.kind, "refund");
  assert.equal(view?.recent[1]?.principal_delta_cents, -1_000);
  assert.equal(await store.sumCashPrincipal(STORE, DAY), 0);

  const common = {
    account_id: accountId,
    store_id: STORE,
    staff_id: STAFF,
    at: 9,
    business_date: DAY,
    note: null,
  } as const;
  assert.deepEqual(await store.topup({ ...common, amount_cents: 1, tender: "cash" }), {
    ok: false,
    reason: "account_closed",
  });
  assert.deepEqual(
    await store.refund({ ...common, amount_cents: 1, tender: "cash", reason: "no" }),
    { ok: false, reason: "account_closed" },
  );
});

test("memory close rejects a stale identity or balance without partial writes", async () => {
  const { store, accountId } = await fundedAccount();
  const wrongCustomer = await store.close({
    account_id: accountId,
    expected_customer_id: "another-customer",
    expected_status_version: 1,
    expected_status: "active",
    expected_principal_cents: 1_000,
    expected_bonus_cents: 200,
    refund_tender: "cash",
    store_id: STORE,
    staff_id: STAFF,
    at: 8,
    business_date: DAY,
    reason: "wrong target",
  });
  assert.deepEqual(wrongCustomer, { ok: false, reason: "account_customer_mismatch" });

  const stale = await store.close({
    account_id: accountId,
    expected_customer_id: CUSTOMER,
    expected_status_version: 1,
    expected_status: "active",
    expected_principal_cents: 999,
    expected_bonus_cents: 200,
    refund_tender: "cash",
    store_id: STORE,
    staff_id: STAFF,
    at: 8,
    business_date: DAY,
    reason: "stale balance",
  });
  assert.deepEqual(stale, { ok: false, reason: "stale_balance" });
  const view = await store.getByCustomer(CUSTOMER, 50);
  assert.equal(view?.account.status, "active");
  assert.equal(view?.account.status_version, 1);
  assert.equal(view?.balance.total_cents, 1_200);
  assert.equal(view?.recent.length, 1);
});

test("memory close forfeits a safe-integer bonus in one exact row", async () => {
  const store = storeWithIds();
  const bonus = Number.MAX_SAFE_INTEGER - 1;
  const rule = await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 1,
    bonus_cents: bonus,
    status: "active",
    staff_id: STAFF,
    at: 1,
    note: null,
  });
  assert.equal(rule.ok, true);
  const opened = await store.openAccount({ customer_id: CUSTOMER, store_id: STORE, at: 2 });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const accountId = opened.value.account.account_id;
  const topped = await store.topup({
    account_id: accountId,
    store_id: STORE,
    amount_cents: 1,
    tender: "cash",
    staff_id: STAFF,
    at: 3,
    business_date: DAY,
    note: null,
  });
  assert.equal(topped.ok, true);

  const closed = await store.close({
    account_id: accountId,
    expected_customer_id: CUSTOMER,
    expected_status_version: 1,
    expected_status: "active",
    expected_principal_cents: 1,
    expected_bonus_cents: bonus,
    refund_tender: "cash",
    store_id: STORE,
    staff_id: STAFF,
    at: 4,
    business_date: DAY,
    reason: "boundary close",
  });
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.value.forfeited_bonus_cents, bonus);
  const view = await store.getByCustomer(CUSTOMER, 10);
  assert.equal(view?.recent.filter((row) => row.kind === "bonus_forfeit").length, 1);
  assert.equal(view?.recent[0]?.bonus_delta_cents, -bonus);
});
