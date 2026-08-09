import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgStatsQuery } from "./pg-source.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

function isolatedBusinessDate(): string {
  const year = randomInt(2200, 10_000);
  const month = randomInt(1, 13);
  const day = randomInt(1, 29);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

async function settleTasks(
  tasks: readonly (() => Promise<unknown>)[],
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

test("PG stats source uses one aggregate per read under store RLS scope", async () => {
  const queries: string[] = [];
  const client = {
    async query<TRow>(sql: string): Promise<{ rows: TRow[]; rowCount: number }> {
      queries.push(sql);
      if (sql.includes("WITH orders_day AS")) {
        return {
          rows: [
            {
              order_count: "2",
              garment_count: "3",
              payable_cents: "5000",
              paid_cents: "3000",
              balance_cents: "2000",
              payment_cents: "1000",
              picked_garment_count: "1",
            } as TRow,
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("AS cash_cents")) {
        return { rows: [{ cash_cents: "0" } as TRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release(): void {
      // Capturing test double.
    },
  } as unknown as PgPoolClient;
  const pool = { connect: async () => client } as unknown as PgPool;

  const source = createPgStatsQuery(pool);
  const summary = await source.daySummary({
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    businessDate: "2026-07-23",
  });

  assert.deepEqual(summary, {
    business_date: "2026-07-23",
    order_count: 2,
    garment_count: 3,
    payable_cents: 5000,
    paid_cents: 3000,
    balance_cents: 2000,
    payment_cents: 1000,
    picked_garment_count: 1,
  });
  const aggregate = queries.find((sql) => sql.includes("WITH orders_day AS"));
  assert.ok(aggregate);
  assert.match(aggregate, /FROM payments p/u);
  assert.match(aggregate, /g\.status = 'picked_up'/u);
  assert.match(aggregate, /o\.status IN \('open', 'closed'\)/u);
  assert.deepEqual(
    await source.cashSummary({
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
      businessDate: "2026-07-23",
    }),
    { cash_cents: 0 },
  );
  const cash = queries.find((sql) => sql.includes("AS cash_cents"));
  assert.ok(cash);
  assert.match(cash, /LEFT JOIN payments referenced/u);
  assert.match(cash, /referenced\.kind = 'refund'/u);
  assert.equal(queries.filter((sql) => sql === "BEGIN").length, 2);
});

test("PG expected cash adds member cash top-ups to order cash (ADR-22 §1.2)", async () => {
  const queries: string[] = [];
  const client = {
    async query<TRow>(sql: string): Promise<{ rows: TRow[]; rowCount: number }> {
      queries.push(sql);
      if (sql.includes("FROM member_ledger")) {
        return { rows: [{ cash_cents: "25000" } as TRow], rowCount: 1 };
      }
      if (sql.includes("AS cash_cents")) {
        return { rows: [{ cash_cents: "100000" } as TRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release(): void {
      // Capturing test double.
    },
  } as unknown as PgPoolClient;
  const pool = { connect: async () => client } as unknown as PgPool;

  const cash = await createPgStatsQuery(pool).cashSummary({
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    businessDate: "2026-08-01",
  });

  assert.deepEqual(cash, { cash_cents: 125_000 });
  const memberCash = queries.find((sql) => sql.includes("FROM member_ledger"));
  assert.ok(memberCash);
  // Only principal: a bonus is a book grant with no banknote behind it.
  assert.match(memberCash, /SUM\(principal_delta_cents\)/u);
  assert.doesNotMatch(memberCash, /bonus_delta_cents/u);
  assert.match(memberCash, /tender = 'cash'/u);
});

maybe(
  "real PG expected cash merges order corrections with member principal and excludes non-cash",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const businessDate = isolatedBusinessDate();
    const orderId = randomUUID();
    const customerId = randomUUID();
    const accountId = randomUUID();
    const bonusRuleId = randomUUID();
    const otherStoreId = randomUUID();
    const cashPayId = randomUUID();
    const cashRefundId = randomUUID();
    const secondCashPayId = randomUUID();
    const cashRefundReversalId = randomUUID();
    const secondCashPayReversalId = randomUUID();
    const wechatPayId = randomUUID();
    const cashTopupLedgerId = randomUUID();
    const cashRefundLedgerId = randomUUID();
    const wechatTopupLedgerId = randomUUID();
    const otherStoreCashTopupLedgerId = randomUUID();
    let exerciseFailed = false;
    let exerciseFailure: unknown;
    let cleanupFailures: readonly unknown[] = [];

    try {
      await seedPgTestIdentityFixture(adminPool);
      const source = createPgStatsQuery(appPool);
      const before = await source.cashSummary({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        businessDate,
      });

      await adminPool.query(
        `INSERT INTO stores (id, org_id, code, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Stats fixture other store', now(), now())`,
        [otherStoreId, DEMO_ORG_ID, `stats-${otherStoreId.slice(0, 8)}`],
      );
      await adminPool.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status,
           subtotal_cents, payable_cents, paid_cents, balance_cents,
           created_at, updated_at, created_by_staff_id, business_date
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'closed',
           10000, 10000, 10000, 0, now(), now(), $5::uuid, $6
         )`,
        [
          orderId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          `cash-${orderId.slice(0, 8)}`,
          DEMO_STAFF_A_ID,
          businessDate,
        ],
      );
      await adminPool.query(
        `INSERT INTO payments (
           id, org_id, store_id, order_id, method, amount_cents, kind,
           ref_payment_id, staff_id, at, business_date
         ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 1000, 'pay',
            NULL, $5::uuid, now(), $6),
           ($7::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 300, 'refund',
            $1::uuid, $5::uuid, now(), $6),
           ($8::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 300, 'reversal',
            $7::uuid, $5::uuid, now(), $6),
           ($9::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 200, 'pay',
            NULL, $5::uuid, now(), $6),
           ($10::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 200, 'reversal',
            $9::uuid, $5::uuid, now(), $6),
           ($11::uuid, $2::uuid, $3::uuid, $4::uuid, 'wechat', 9000, 'pay',
            NULL, $5::uuid, now(), $6)`,
        [
          cashPayId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          orderId,
          DEMO_STAFF_A_ID,
          businessDate,
          cashRefundId,
          cashRefundReversalId,
          secondCashPayId,
          secondCashPayReversalId,
          wechatPayId,
        ],
      );
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Stats fixture member', now(), now())`,
        [customerId, DEMO_ORG_ID, `139${randomInt(0, 100_000_000).toString().padStart(8, "0")}`],
      );
      await adminPool.query(
        `INSERT INTO member_accounts (
           id, org_id, customer_id, status, opened_at, opened_store_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', now(), $4::uuid)`,
        [accountId, DEMO_ORG_ID, customerId, DEMO_STORE_ID],
      );
      await adminPool.query(
        `INSERT INTO member_bonus_rules (
           id, org_id, min_topup_cents, bonus_cents, status,
           effective_from, updated_at, updated_by_staff_id, note
         ) VALUES (
           $1::uuid, $2::uuid, 1, 500, 'retired',
           now(), now(), $3::uuid, 'Stats cash aggregation fixture'
         )`,
        [bonusRuleId, DEMO_ORG_ID, DEMO_STAFF_A_ID],
      );
      await adminPool.query(
        `INSERT INTO member_ledger (
           id, org_id, store_id, account_id, kind,
           principal_delta_cents, bonus_delta_cents, staff_id,
           at, business_date, tender, bonus_rule_id
         ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup',
            2000, 500, $5::uuid, now(), $6, 'cash', $7::uuid),
           ($8::uuid, $2::uuid, $3::uuid, $4::uuid, 'refund',
            -400, 0, $5::uuid, now(), $6, 'cash', NULL),
           ($9::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup',
            8000, 500, $5::uuid, now(), $6, 'wechat', $7::uuid),
           ($10::uuid, $2::uuid, $11::uuid, $4::uuid, 'topup',
            50000, 0, $5::uuid, now(), $6, 'cash', NULL)`,
        [
          cashTopupLedgerId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          accountId,
          DEMO_STAFF_A_ID,
          businessDate,
          bonusRuleId,
          cashRefundLedgerId,
          wechatTopupLedgerId,
          otherStoreCashTopupLedgerId,
          otherStoreId,
        ],
      );

      const after = await source.cashSummary({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        businessDate,
      });

      // Orders contribute 1000: refund + reversal cancel, as do pay + reversal.
      // Members contribute 1600 of cash principal; both bonus and WeChat stay out.
      // The same-org cash top-up attributed to another store must also stay out.
      assert.equal(after.cash_cents - before.cash_cents, 2_600);
    } catch (error) {
      exerciseFailed = true;
      exerciseFailure = error;
    } finally {
      try {
        const ledgerAndPayments = await settleTasks([
          async () =>
            adminPool.query(
              `DELETE FROM member_ledger
                WHERE id = ANY($1::uuid[])`,
              [
                [
                  cashTopupLedgerId,
                  cashRefundLedgerId,
                  wechatTopupLedgerId,
                  otherStoreCashTopupLedgerId,
                ],
              ],
            ),
          async () => adminPool.query("DELETE FROM payments WHERE order_id = $1::uuid", [orderId]),
        ]);
        const accountAndRule = await settleTasks([
          async () =>
            adminPool.query("DELETE FROM member_accounts WHERE id = $1::uuid", [accountId]),
          async () =>
            adminPool.query("DELETE FROM member_bonus_rules WHERE id = $1::uuid", [bonusRuleId]),
        ]);
        const customerAndOrder = await settleTasks([
          async () => adminPool.query("DELETE FROM customers WHERE id = $1::uuid", [customerId]),
          async () => adminPool.query("DELETE FROM orders WHERE id = $1::uuid", [orderId]),
        ]);
        const otherStore = await settleTasks([
          async () => adminPool.query("DELETE FROM stores WHERE id = $1::uuid", [otherStoreId]),
        ]);
        cleanupFailures = [
          ...ledgerAndPayments,
          ...accountAndRule,
          ...customerAndOrder,
          ...otherStore,
        ];
      } finally {
        cleanupFailures = [
          ...cleanupFailures,
          ...(await settleTasks([async () => appPool.end(), async () => adminPool.end()])),
        ];
      }
    }

    const failures = exerciseFailed ? [exerciseFailure, ...cleanupFailures] : [...cleanupFailures];
    if (failures.length > 0) {
      throw new AggregateError(failures, "real PG stats fixture or cleanup failed");
    }
  },
);
