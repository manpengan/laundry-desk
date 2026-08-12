/**
 * Real PostgreSQL regressions for the stored-value ledger.
 * SQL-text mocks would miss database constraints; money paths require real rows.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgMemberStore } from "./pg-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

const BUSINESS_DATE = "2026-08-01";

async function withStore<T>(
  run: (store: ReturnType<typeof createPgMemberStore>) => Promise<T>,
): Promise<T> {
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    return await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => run(createPgMemberStore(tx, TENANT))),
    );
  } finally {
    await pool.end();
  }
}

/** A customer the member account can hang off, created in its own transaction. */
async function seedCustomer(): Promise<string> {
  const customerId = randomUUID();
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => {
        await tx.query(
          `INSERT INTO customers (id, org_id, phone, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, now(), now())`,
          [customerId, TENANT.orgId, `139${String(Date.now()).slice(-8)}`],
        );
      }),
    );
  } finally {
    await pool.end();
  }
  return customerId;
}

/** A real order for the ledger's order FK to point at. */
async function seedOrder(
  customerId: string,
  businessDate: string = BUSINESS_DATE,
): Promise<string> {
  const orderId = randomUUID();
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => {
        await tx.query(
          `INSERT INTO orders (
             id, org_id, store_id, customer_id, status, subtotal_cents, payable_cents,
             paid_cents, balance_cents, created_at, updated_at,
             created_by_staff_id, business_date
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'open', 5000, 5000,
             0, 5000, now(), now(), $5::uuid, $6
           )`,
          [orderId, TENANT.orgId, TENANT.storeId, customerId, TENANT.staffId, businessDate],
        );
      }),
    );
  } finally {
    await pool.end();
  }
  return orderId;
}

maybe("seeds the identity fixture the member tables reference", async () => {
  const pool = createPgPool({ connectionString: urls!.admin });
  try {
    await seedPgTestIdentityFixture(pool);
  } finally {
    await pool.end();
  }
});

maybe("opening the same customer twice returns one account", async () => {
  const customerId = await seedCustomer();

  const first = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  const second = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_100 }),
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.created, true);
  assert.equal(second.value.created, false);
  assert.equal(first.value.account.account_id, second.value.account.account_id);
});

maybe("opening an account for an unknown customer is refused", async () => {
  const outcome = await withStore((store) =>
    store.openAccount({ customer_id: randomUUID(), store_id: TENANT.storeId, at: 1_780_000_000 }),
  );

  assert.deepEqual(outcome, { ok: false, reason: "customer_not_found" });
});

maybe("a top-up lands as a real row and the balance sums to it", async () => {
  const customerId = await seedCustomer();
  const opened = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const accountId = opened.value.account.account_id;

  const topped = await withStore((store) =>
    store.topup({
      account_id: accountId,
      store_id: TENANT.storeId,
      amount_cents: 20_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  assert.equal(topped.ok, true);
  if (!topped.ok) return;
  assert.deepEqual(topped.value.balance, {
    principal_cents: 20_000,
    bonus_cents: 0,
    total_cents: 20_000,
  });

  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.balance.total_cents, 20_000);
  assert.equal(view?.recent[0]?.kind, "topup");
});

maybe("a spend beyond the balance is refused and leaves no ledger row", async () => {
  const customerId = await seedCustomer();
  const opened = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const accountId = opened.value.account.account_id;
  await withStore((store) =>
    store.topup({
      account_id: accountId,
      store_id: TENANT.storeId,
      amount_cents: 1_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  const orderId = await seedOrder(customerId);
  const outcome = await withStore((store) =>
    store.spend({
      account_id: accountId,
      store_id: TENANT.storeId,
      order_id: orderId,
      order_customer_id: customerId,
      amount_cents: 1_001,
      staff_id: TENANT.staffId,
      at: 1_780_000_300,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  assert.deepEqual(outcome, { ok: false, reason: "insufficient_balance" });
  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.balance.total_cents, 1_000);
  assert.equal(view?.recent.length, 1);
});

maybe("a successful spend writes a real ledger row against the order", async () => {
  const customerId = await seedCustomer();
  const orderId = await seedOrder(customerId);
  const opened = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const accountId = opened.value.account.account_id;
  await withStore((store) =>
    store.topup({
      account_id: accountId,
      store_id: TENANT.storeId,
      amount_cents: 10_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  const spent = await withStore((store) =>
    store.spend({
      account_id: accountId,
      store_id: TENANT.storeId,
      order_id: orderId,
      order_customer_id: customerId,
      amount_cents: 4_200,
      staff_id: TENANT.staffId,
      at: 1_780_000_300,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  assert.equal(spent.ok, true);
  if (!spent.ok) return;
  assert.equal(spent.value.balance.total_cents, 5_800);
  assert.equal(spent.value.principal_delta_cents, -4_200);

  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.balance.total_cents, 5_800);
  assert.equal(view?.recent[0]?.kind, "pay");
  assert.equal(view?.recent[0]?.order_id, orderId);
  // The projection must equal the rows it just returned, on a real table.
  const summed = (view?.recent ?? []).reduce(
    (total, row) => total + row.principal_delta_cents + row.bonus_delta_cents,
    0,
  );
  assert.equal(summed, view?.balance.total_cents);
});

maybe("a member account cannot settle another customer's order", async () => {
  const accountCustomerId = await seedCustomer();
  const orderCustomerId = await seedCustomer();
  const orderId = await seedOrder(orderCustomerId);
  const accountId = await openAccountFor(accountCustomerId);
  await withStore((store) =>
    store.topup({
      account_id: accountId,
      store_id: TENANT.storeId,
      amount_cents: 10_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  const outcome = await withStore((store) =>
    store.spend({
      account_id: accountId,
      store_id: TENANT.storeId,
      order_id: orderId,
      order_customer_id: orderCustomerId,
      amount_cents: 1_000,
      staff_id: TENANT.staffId,
      at: 1_780_000_300,
      business_date: BUSINESS_DATE,
      note: "must not cross customer boundary",
    }),
  );

  assert.deepEqual(outcome, { ok: false, reason: "account_customer_mismatch" });
  const view = await withStore((store) => store.getByCustomer(accountCustomerId, 10));
  assert.equal(view?.balance.total_cents, 10_000);
  assert.equal(view?.recent.length, 1);
});

maybe("two concurrent spends cannot both take the same money", async () => {
  const customerId = await seedCustomer();
  const opened = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const accountId = opened.value.account.account_id;
  await withStore((store) =>
    store.topup({
      account_id: accountId,
      store_id: TENANT.storeId,
      amount_cents: 1_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  // Each spend runs in its own transaction on its own connection, both asking
  // for the whole balance. Without FOR UPDATE both would read 1000 and both
  // would succeed, leaving -1000.
  const orderId = await seedOrder(customerId);
  const spendWhole = (): Promise<{ ok: boolean }> =>
    withStore((store) =>
      store.spend({
        account_id: accountId,
        store_id: TENANT.storeId,
        order_id: orderId,
        order_customer_id: customerId,
        amount_cents: 1_000,
        staff_id: TENANT.staffId,
        at: 1_780_000_400,
        business_date: BUSINESS_DATE,
        note: null,
      }),
    );

  const [left, right] = await Promise.all([spendWhole(), spendWhole()]);
  const succeeded = [left, right].filter((outcome) => outcome.ok).length;

  assert.equal(succeeded, 1, "exactly one concurrent spend may take the balance");
  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.balance.total_cents, 0);
  assert.ok((view?.balance.total_cents ?? -1) >= 0, "the balance must never go negative");
});

maybe("the ledger rejects UPDATE for the application role", async () => {
  const customerId = await seedCustomer();
  const opened = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await withStore((store) =>
    store.topup({
      account_id: opened.value.account.account_id,
      store_id: TENANT.storeId,
      amount_cents: 5_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: BUSINESS_DATE,
      note: null,
    }),
  );

  // Append-only is enforced by privilege, not by application discipline: even a
  // deliberate UPDATE from the runtime role must be refused by PostgreSQL.
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    await assert.rejects(
      () =>
        withPoolClient(pool, async (client) =>
          withTenantTransaction(client, TENANT, async (tx) => {
            await tx.query(
              `UPDATE member_ledger SET principal_delta_cents = 999999
                WHERE org_id = $1::uuid`,
              [TENANT.orgId],
            );
          }),
        ),
      /permission denied/iu,
    );
  } finally {
    await pool.end();
  }

  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.balance.total_cents, 5_000);
});

/**
 * Insert straight into the ledger, bypassing the store.
 *
 * The CHECKs below are the guarantee that no future write path can attach a
 * tender to a settlement or invent a tender the cash rollup cannot read. Going
 * through the store would only prove the store behaves, which is the thing the
 * constraint exists to stop depending on.
 */
async function insertRawLedger(
  values: Readonly<{
    accountId: string;
    kind: "topup" | "pay" | "reversal";
    principal: number;
    bonus?: number;
    bonusRuleId?: string | null;
    orderId: string | null;
    refLedgerId?: string | null;
    tender: string | null;
    businessDate: string;
  }>,
): Promise<string> {
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    return await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => {
        const ledgerId = randomUUID();
        await tx.query(
          `INSERT INTO member_ledger (
             id, org_id, store_id, account_id, kind,
             principal_delta_cents, bonus_delta_cents, order_id, ref_ledger_id, tender,
             bonus_rule_id, staff_id, at, business_date, note
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
             $6::bigint, $7::bigint, $8::uuid, $9::uuid, $10,
             $11::uuid, $12::uuid, now(), $13, NULL
           )`,
          [
            ledgerId,
            TENANT.orgId,
            TENANT.storeId,
            values.accountId,
            values.kind,
            values.principal,
            values.bonus ?? 0,
            values.orderId,
            values.refLedgerId ?? null,
            values.tender,
            values.bonusRuleId ?? null,
            TENANT.staffId,
            values.businessDate,
          ],
        );
        return ledgerId;
      }),
    );
  } finally {
    await pool.end();
  }
}

async function openAccountFor(customerId: string): Promise<string> {
  const opened = await withStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  return opened.value.account.account_id;
}

async function seedRawBalance(
  accountId: string,
  principalCents: number,
  bonusCents: number,
): Promise<void> {
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => {
        const bonusRuleId = bonusCents > 0 ? randomUUID() : null;
        if (bonusRuleId !== null) {
          await tx.query(
            `INSERT INTO member_bonus_rules (
               id, org_id, min_topup_cents, bonus_cents, status,
               effective_from, updated_at, updated_by_staff_id, note
             ) VALUES (
               $1::uuid, $2::uuid, 1, 1, 'retired', now(), now(), $3::uuid, NULL
             )`,
            [bonusRuleId, TENANT.orgId, TENANT.staffId],
          );
        }
        await tx.query(
          `INSERT INTO member_ledger (
             id, org_id, store_id, account_id, kind,
             principal_delta_cents, bonus_delta_cents, order_id, tender,
             bonus_rule_id, staff_id, at, business_date, note
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup',
             $5::bigint, $6::bigint, NULL, 'cash',
             $7::uuid, $8::uuid, now(), $9, NULL
           )`,
          [
            randomUUID(),
            TENANT.orgId,
            TENANT.storeId,
            accountId,
            principalCents,
            bonusCents,
            bonusRuleId,
            TENANT.staffId,
            BUSINESS_DATE,
          ],
        );
      }),
    );
  } finally {
    await pool.end();
  }
}

maybe("a cash top-up persists its tender and only cash reaches the day sum", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);
  const isolatedDate = "2026-08-11";

  const before = await withStore((store) => store.sumCashPrincipal(TENANT.storeId, isolatedDate));

  for (const [amount, tender] of [
    [30_000, "cash"],
    [70_000, "wechat"],
  ] as const) {
    const result = await withStore((store) =>
      store.topup({
        account_id: accountId,
        store_id: TENANT.storeId,
        amount_cents: amount,
        tender,
        staff_id: TENANT.staffId,
        at: 1_780_000_200,
        business_date: isolatedDate,
        note: null,
      }),
    );
    assert.equal(result.ok, true);
  }

  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.recent[0]?.tender, "wechat");
  assert.equal(view?.recent[1]?.tender, "cash");

  // Only the cash tender counts: the wechat top-up put no banknote in the drawer.
  const after = await withStore((store) => store.sumCashPrincipal(TENANT.storeId, isolatedDate));
  assert.equal(after - before, 30_000);
});

maybe(
  "a confirmed top-up persists its server-frozen bonus after the tier is repriced",
  async () => {
    const customerId = await seedCustomer();
    const accountId = await openAccountFor(customerId);
    const created = await withStore((store) =>
      store.upsertBonusRule({
        rule_id: null,
        min_topup_cents: 123_400,
        bonus_cents: 12_340,
        status: "active",
        staff_id: TENANT.staffId,
        at: 1_780_000_100,
        note: "frozen confirmation regression",
      }),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const repriced = await withStore((store) =>
      store.upsertBonusRule({
        rule_id: created.value.rule_id,
        min_topup_cents: created.value.min_topup_cents,
        bonus_cents: 1,
        status: "active",
        staff_id: TENANT.staffId,
        at: 1_780_000_101,
        note: "repriced after first hop",
      }),
    );
    assert.equal(repriced.ok, true);

    const topped = await withStore((store) =>
      store.topup({
        account_id: accountId,
        store_id: TENANT.storeId,
        amount_cents: 123_400,
        tender: "cash",
        staff_id: TENANT.staffId,
        at: 1_780_000_200,
        business_date: "2026-08-15",
        note: null,
        frozen_bonus: {
          rule_id: created.value.rule_id,
          bonus_cents: 12_340,
        },
      }),
    );
    assert.equal(topped.ok, true);
    if (!topped.ok) return;
    assert.equal(topped.value.bonus_delta_cents, 12_340);

    const view = await withStore((store) => store.getByCustomer(customerId, 10));
    assert.equal(view?.recent[0]?.bonus_delta_cents, 12_340);
    assert.equal(view?.recent[0]?.bonus_rule_id, created.value.rule_id);
  },
);

maybe("a settlement carries no tender, so it never double-counts the drawer", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);
  const isolatedDate = "2026-08-12";
  const orderId = await seedOrder(customerId, isolatedDate);

  const toppedUp = await withStore((store) =>
    store.topup({
      account_id: accountId,
      store_id: TENANT.storeId,
      amount_cents: 50_000,
      tender: "cash",
      staff_id: TENANT.staffId,
      at: 1_780_000_200,
      business_date: isolatedDate,
      note: null,
    }),
  );
  assert.equal(toppedUp.ok, true);
  // Measure across the settlement, not against an absolute figure: these run on
  // a shared volume, so a re-run on the same store-day accumulates and an
  // absolute assertion would fail for a reason unrelated to the claim.
  const beforeSpend = await withStore((store) =>
    store.sumCashPrincipal(TENANT.storeId, isolatedDate),
  );
  const spent = await withStore((store) =>
    store.spend({
      account_id: accountId,
      store_id: TENANT.storeId,
      order_id: orderId,
      order_customer_id: customerId,
      amount_cents: 20_000,
      staff_id: TENANT.staffId,
      at: 1_780_000_400,
      business_date: isolatedDate,
      note: null,
    }),
  );
  assert.equal(spent.ok, true);

  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.recent[0]?.kind, "pay");
  assert.equal(view?.recent[0]?.tender, null);
  const afterSpend = await withStore((store) =>
    store.sumCashPrincipal(TENANT.storeId, isolatedDate),
  );
  // The settlement moved no cash: that money entered on the top-up day.
  assert.equal(afterSpend - beforeSpend, 0);
});

maybe("PostgreSQL refuses a settlement row that claims a tender", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);
  const isolatedDate = "2026-08-13";
  const orderId = await seedOrder(customerId, isolatedDate);

  await assert.rejects(
    insertRawLedger({
      accountId,
      kind: "pay",
      principal: -1_000,
      orderId,
      tender: "cash",
      businessDate: isolatedDate,
    }),
    /member_ledger_pay_tender_chk/u,
  );
});

maybe("PostgreSQL refuses a tender the cash rollup cannot read", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);

  await assert.rejects(
    insertRawLedger({
      accountId,
      kind: "topup",
      principal: 1_000,
      orderId: null,
      tender: "bitcoin",
      businessDate: "2026-08-14",
    }),
    /member_ledger_tender_value_chk/u,
  );
});

maybe("PostgreSQL refuses a positive bonus without its frozen rule origin", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);

  await assert.rejects(
    insertRawLedger({
      accountId,
      kind: "topup",
      principal: 1_000,
      bonus: 1,
      orderId: null,
      tender: "cash",
      businessDate: "2026-08-16",
    }),
    /member_ledger_positive_bonus_origin_chk/u,
  );
});

maybe("PostgreSQL permits a reversal to restore previously consumed bonus", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);
  const businessDate = "2026-08-17";
  const debitId = await insertRawLedger({
    accountId,
    kind: "pay",
    principal: 0,
    bonus: -1,
    orderId: await seedOrder(customerId, businessDate),
    tender: null,
    businessDate,
  });

  await assert.doesNotReject(
    insertRawLedger({
      accountId,
      kind: "reversal",
      principal: 0,
      bonus: 1,
      orderId: null,
      refLedgerId: debitId,
      tender: null,
      businessDate,
    }),
  );
});

maybe("two concurrent closes settle the account exactly once", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);
  await seedRawBalance(accountId, 500, 0);
  const input = {
    account_id: accountId,
    expected_customer_id: customerId,
    expected_status_version: 1,
    expected_status: "active" as const,
    expected_principal_cents: 500,
    expected_bonus_cents: 0,
    refund_tender: "cash" as const,
    store_id: TENANT.storeId,
    staff_id: TENANT.staffId,
    at: 1_780_000_500,
    business_date: BUSINESS_DATE,
    reason: "concurrent close",
  };

  const outcomes = await Promise.all([
    withStore((store) => store.close(input)),
    withStore((store) => store.close(input)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
  assert.equal(
    outcomes.some((outcome) => !outcome.ok && outcome.reason === "account_version_conflict"),
    true,
  );
  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  assert.equal(view?.account.status, "closed");
  assert.equal(view?.balance.total_cents, 0);
  assert.equal(view?.recent.filter((row) => row.kind === "refund").length, 1);
});

maybe("PostgreSQL closes a safe-integer bonus with one bigint forfeiture", async () => {
  const customerId = await seedCustomer();
  const accountId = await openAccountFor(customerId);
  const bonus = Number.MAX_SAFE_INTEGER - 1;
  await seedRawBalance(accountId, 1, bonus);

  const closed = await withStore((store) =>
    store.close({
      account_id: accountId,
      expected_customer_id: customerId,
      expected_status_version: 1,
      expected_status: "active",
      expected_principal_cents: 1,
      expected_bonus_cents: bonus,
      refund_tender: "cash",
      store_id: TENANT.storeId,
      staff_id: TENANT.staffId,
      at: 1_780_000_600,
      business_date: BUSINESS_DATE,
      reason: "safe integer boundary",
    }),
  );
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.value.forfeited_bonus_cents, bonus);
  const view = await withStore((store) => store.getByCustomer(customerId, 10));
  const forfeitures = view?.recent.filter((row) => row.kind === "bonus_forfeit") ?? [];
  assert.equal(forfeitures.length, 1);
  assert.equal(forfeitures[0]?.bonus_delta_cents, -bonus);
});
