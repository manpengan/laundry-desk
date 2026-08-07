import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgAccountingSource } from "./pg-source.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;
const BUSINESS_DATE = "2098-08-07";
const OTHER_STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["accounting_read", "ledger_export"]),
});

function fictionalPhone(): string {
  const suffix = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 8)}`) % 100_000_000n;
  return `139${suffix.toString().padStart(8, "0")}`;
}

async function seedOtherStore(adminPool: PgPool): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'other-report', 'Other report store', 'UTC', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_STORE_ID, DEMO_ORG_ID],
    );
    const customerId = randomUUID();
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Other store member', now(), now())`,
      [customerId, DEMO_ORG_ID, fictionalPhone()],
    );
    await client.query(
      `INSERT INTO member_accounts (id, org_id, customer_id, status, opened_at, opened_store_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', now(), $4::uuid)`,
      [accountId, DEMO_ORG_ID, customerId, OTHER_STORE_ID],
    );
    await client.query(
      `INSERT INTO member_ledger (
         id, org_id, store_id, account_id, kind, principal_delta_cents,
         bonus_delta_cents, staff_id, at, business_date, tender
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup', 99999,
                 0, $5::uuid, now(), $6, 'cash')`,
      [randomUUID(), DEMO_ORG_ID, OTHER_STORE_ID, accountId, DEMO_ADMIN_ID, BUSINESS_DATE],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedCurrentStore(appPool: PgPool): Promise<void> {
  const customerId = randomUUID();
  const accountId = randomUUID();
  const orderId = randomUUID();
  const cashPaymentId = randomUUID();
  const balancePaymentId = randomUUID();
  const reversalPaymentId = randomUUID();
  await withPoolClient(appPool, (client) =>
    withTenantTransaction(client, TENANT, async (tx) => {
      await tx.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Accounting member', now(), now())`,
        [customerId, DEMO_ORG_ID, fictionalPhone()],
      );
      await tx.query(
        `INSERT INTO member_accounts (id, org_id, customer_id, status, opened_at, opened_store_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', now(), $4::uuid)`,
        [accountId, DEMO_ORG_ID, customerId, DEMO_STORE_ID],
      );
      await tx.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, customer_id,
           subtotal_cents, payable_cents, paid_cents, balance_cents,
           created_at, updated_at, created_by_staff_id, business_date
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'closed', $5::uuid,
                   8000, 8000, 8000, 0, now(), now(), $6::uuid, $7)`,
        [
          orderId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          `ACC-${orderId.slice(0, 8)}`,
          customerId,
          DEMO_ADMIN_ID,
          BUSINESS_DATE,
        ],
      );
      await tx.query(
        `INSERT INTO payments (
           id, org_id, store_id, order_id, method, amount_cents, kind,
           staff_id, at, business_date, ref_payment_id
         ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 5000, 'pay',
            $5::uuid, now(), $6, NULL),
           ($7::uuid, $2::uuid, $3::uuid, $4::uuid, 'balance', 3000, 'pay',
            $8::uuid, now(), $6, NULL),
           ($9::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 3000, 'reversal',
            $8::uuid, now(), $6, $7::uuid)`,
        [
          cashPaymentId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          orderId,
          DEMO_ADMIN_ID,
          BUSINESS_DATE,
          balancePaymentId,
          DEMO_STAFF_A_ID,
          reversalPaymentId,
        ],
      );
      await tx.query(
        `INSERT INTO member_ledger (
           id, org_id, store_id, account_id, kind, principal_delta_cents,
           bonus_delta_cents, order_id, staff_id, at, business_date, tender
         ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup', 10000, 1000, NULL,
            $5::uuid, now(), $6, 'cash'),
           ($7::uuid, $2::uuid, $3::uuid, $4::uuid, 'refund', -2000, 0, NULL,
            $8::uuid, now(), $6, 'cash'),
           ($9::uuid, $2::uuid, $3::uuid, $4::uuid, 'pay', -2000, -1000, $10::uuid,
            $8::uuid, now(), $6, NULL)`,
        [
          randomUUID(),
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          accountId,
          DEMO_ADMIN_ID,
          BUSINESS_DATE,
          randomUUID(),
          DEMO_STAFF_A_ID,
          randomUUID(),
          orderId,
        ],
      );
    }),
  );
}

maybe("real PG accounting report keeps dual bases and excludes another store", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  try {
    await seedPgTestIdentityFixture(adminPool);
    await seedOtherStore(adminPool);
    await seedCurrentStore(appPool);
    const { queryRegistry } = createRegisteredM1Bus({
      accounting: Object.freeze({
        source: createPgAccountingSource(),
        timeZone: "UTC",
        now: () => new Date("2098-08-07T12:00:00.000Z"),
      }),
    });
    const queried = await withPoolClient(appPool, (client) =>
      executeQuery(
        client,
        TENANT,
        "accounting.report.get",
        { date_from: BUSINESS_DATE, date_to: BUSINESS_DATE, group_by: "staff" },
        { registry: queryRegistry, actor: ACTOR },
      ),
    );
    assert.equal(queried.ok, true, JSON.stringify(queried));
    if (!queried.ok) return;
    const report = queried.data.result as {
      totals: { real_income_cents: number; performance_income_cents: number };
      rows: Array<{ label: string; real_income_cents: number; performance_income_cents: number }>;
    };
    assert.deepEqual(report.totals, {
      real_income_cents: 13_000,
      performance_income_cents: 5_000,
      order_cashflow_cents: 5_000,
      stored_value_cashflow_cents: 8_000,
      stored_value_consumption_cents: 0,
      ledger_row_count: 5,
    });
    assert.equal(report.rows.length, 2);
    assert.ok(report.rows.some((row) => row.real_income_cents === 15_000));
    assert.ok(report.rows.some((row) => row.performance_income_cents === 0));
  } finally {
    await adminPool.end();
    await appPool.end();
  }
});
