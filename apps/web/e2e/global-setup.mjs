/**
 * Seed fictional secondary staff for the real local Web acceptance.
 *
 * The production bootstrap intentionally creates only the administrator.
 * Quick-switch needs a second actor, so the browser suite installs a bounded,
 * idempotent fixture by copying the bootstrap administrator's password/PIN
 * hashes. No credential is logged or placed in SQL text.
 */
import { createRequire } from "node:module";

import { loadLocalConfig } from "../../../tools/local/config.mjs";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const pg = requireFromServer("pg");

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_ID = "11111111-1111-4111-8111-111111111103";
const FIXTURE_STAFF = Object.freeze([
  Object.freeze({
    id: "11111111-1111-4111-8111-111111111101",
    roleId: "55555555-5555-4555-8555-111111111101",
    username: "e2e-staff-a",
    displayName: "E2E Staff One",
    role: "staff",
  }),
  Object.freeze({
    id: "11111111-1111-4111-8111-111111111102",
    roleId: "55555555-5555-4555-8555-111111111102",
    username: "e2e-staff-b",
    displayName: "E2E Staff Two",
    role: "admin",
  }),
]);

const REMINDER_FIXTURE = Object.freeze({
  customerId: "66666666-6666-4666-8666-666666666661",
  orderId: "66666666-6666-4666-8666-666666666662",
  lineId: "66666666-6666-4666-8666-666666666663",
  garmentId: "66666666-6666-4666-8666-666666666664",
  name: "E2E 催取顾客",
  phone: "13400000000",
  ticket: "E2E-REMINDER-0001",
});

const ACCOUNTING_FIXTURE = Object.freeze({
  businessDate: "2097-08-07",
  customerId: "77777777-7777-4777-8777-777777777661",
  accountId: "77777777-7777-4777-8777-777777777662",
  orderId: "77777777-7777-4777-8777-777777777663",
  cashPaymentId: "77777777-7777-4777-8777-777777777664",
  balancePaymentId: "77777777-7777-4777-8777-777777777665",
  topupLedgerId: "77777777-7777-4777-8777-777777777666",
  refundLedgerId: "77777777-7777-4777-8777-777777777667",
  payLedgerId: "77777777-7777-4777-8777-777777777668",
});

function adminDatabaseUrl(password) {
  const url = new URL("postgresql://127.0.0.1:8543/laundry_v2");
  url.username = "postgres";
  url.password = password;
  return url.toString();
}

async function seedStaff(client, staff) {
  await client.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at
     )
     SELECT $1::uuid, $2::uuid, $3, admin.password_hash, admin.pin_hash, $4,
            true, 1, now(), now()
       FROM staffs admin
      WHERE admin.id = $5::uuid
        AND admin.org_id = $2::uuid
        AND admin.password_hash IS NOT NULL
        AND admin.pin_hash IS NOT NULL
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       pin_hash = EXCLUDED.pin_hash,
       display_name = EXCLUDED.display_name,
       is_active = true,
       updated_at = EXCLUDED.updated_at`,
    [staff.id, ORG_ID, staff.username, staff.displayName, ADMIN_ID],
  );
  await client.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, true, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       role = EXCLUDED.role,
       is_active = true,
       updated_at = EXCLUDED.updated_at`,
    [staff.roleId, ORG_ID, STORE_ID, staff.id, staff.role],
  );
}

async function seedReminderFixture(client) {
  const row = REMINDER_FIXTURE;
  await client.query(
    `INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'Playwright pickup reminder fixture',
             now() - interval '200 days', now())
     ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, name = EXCLUDED.name,
       merged_into_id = NULL, merged_at = NULL, updated_at = now()`,
    [row.customerId, ORG_ID, row.phone, row.name],
  );
  await client.query(
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, pickup_code, status, customer_id,
       customer_phone, customer_name, note, subtotal_cents, original_cents,
       discount_cents, addon_cents, urgent_cents, freight_cents, payable_cents,
       paid_cents, balance_cents, business_date, created_at, updated_at,
       created_by_staff_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'E2ER0001', 'open', $5::uuid,
       $6, $7, 'Playwright pickup reminder fixture', 1234, 1234,
       0, 0, 0, 0, 1234, 0, 1234,
       to_char((now() - interval '200 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
       now() - interval '200 days', now(), $8::uuid
     ) ON CONFLICT (id) DO UPDATE SET
       status = 'open', customer_id = EXCLUDED.customer_id,
       customer_phone = EXCLUDED.customer_phone, customer_name = EXCLUDED.customer_name,
       paid_cents = 0, balance_cents = 1234,
       created_at = now() - interval '200 days', updated_at = now()`,
    [row.orderId, ORG_ID, STORE_ID, row.ticket, row.customerId, row.phone, row.name, ADMIN_ID],
  );
  await client.query(
    `INSERT INTO order_lines (
       id, org_id, store_id, order_id, line_index, service_code, category_code,
       unit_price_cents, qty, line_total_cents, color, brand
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'wash', 'coat',
               1234, 1, 1234, 'blue', 'e2e')
     ON CONFLICT (id) DO UPDATE SET unit_price_cents = 1234, qty = 1,
       line_total_cents = 1234`,
    [row.lineId, ORG_ID, STORE_ID, row.orderId],
  );
  await client.query(
    `INSERT INTO garments (
       id, org_id, store_id, order_id, order_line_id, seq, barcode,
       service_code, category_code, unit_price_cents, color, brand, status,
       rack_zone, rack_slot, racked_at, racked_by_staff_id
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
       'E2E-REMINDER-GARMENT', 'wash', 'coat', 1234, 'blue', 'e2e',
       'racked', 'E2E', '001', now() - interval '190 days', $6::uuid)
     ON CONFLICT (id) DO UPDATE SET status = 'racked', rack_zone = 'E2E', rack_slot = '001',
       racked_at = now() - interval '190 days', racked_by_staff_id = EXCLUDED.racked_by_staff_id`,
    [row.garmentId, ORG_ID, STORE_ID, row.orderId, row.lineId, ADMIN_ID],
  );
}

async function seedAccountingFixture(client) {
  const row = ACCOUNTING_FIXTURE;
  await client.query(
    `INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, '13500000024', 'E2E 账目顾客', 'Playwright accounting fixture',
             now(), now())
     ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, name = EXCLUDED.name,
       updated_at = now()`,
    [row.customerId, ORG_ID],
  );
  await client.query(
    `INSERT INTO member_accounts (
       id, org_id, customer_id, status, opened_at, opened_store_id
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', now(), $4::uuid)
     ON CONFLICT (id) DO NOTHING`,
    [row.accountId, ORG_ID, row.customerId, STORE_ID],
  );
  await client.query(
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, pickup_code, status, customer_id,
       subtotal_cents, original_cents, discount_cents, addon_cents,
       urgent_cents, freight_cents, payable_cents, paid_cents, balance_cents,
       business_date, created_at, updated_at, created_by_staff_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'E2E-ACCOUNTING-0001', 'E2EA0001', 'closed',
       $4::uuid, 8000, 8000, 0, 0, 0, 0, 8000, 8000, 0, $5, now(), now(), $6::uuid
     ) ON CONFLICT (id) DO UPDATE SET
       status = 'closed', payable_cents = 8000, paid_cents = 8000,
       balance_cents = 0, business_date = EXCLUDED.business_date, updated_at = now()`,
    [row.orderId, ORG_ID, STORE_ID, row.customerId, row.businessDate, ADMIN_ID],
  );
  await client.query(
    `INSERT INTO payments (
       id, org_id, store_id, order_id, method, amount_cents, kind,
       staff_id, at, business_date
     ) VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 5000, 'pay',
        $5::uuid, now(), $6),
       ($7::uuid, $2::uuid, $3::uuid, $4::uuid, 'balance', 3000, 'pay',
        $8::uuid, now(), $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      row.cashPaymentId,
      ORG_ID,
      STORE_ID,
      row.orderId,
      ADMIN_ID,
      row.businessDate,
      row.balancePaymentId,
      FIXTURE_STAFF[0].id,
    ],
  );
  await client.query(
    `INSERT INTO member_ledger (
       id, org_id, store_id, account_id, kind, principal_delta_cents,
       bonus_delta_cents, order_id, staff_id, at, business_date, tender
     ) VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup', 10000, 1000, NULL,
        $5::uuid, now(), $6, 'cash'),
       ($7::uuid, $2::uuid, $3::uuid, $4::uuid, 'refund', -2000, 0, NULL,
        $8::uuid, now(), $6, 'cash'),
       ($9::uuid, $2::uuid, $3::uuid, $4::uuid, 'pay', -2000, -1000, $10::uuid,
        $8::uuid, now(), $6, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [
      row.topupLedgerId,
      ORG_ID,
      STORE_ID,
      row.accountId,
      ADMIN_ID,
      row.businessDate,
      row.refundLedgerId,
      FIXTURE_STAFF[0].id,
      row.payLedgerId,
      row.orderId,
    ],
  );
}

export default async function globalSetup() {
  const config = await loadLocalConfig();
  const pool = new pg.Pool({
    connectionString: adminDatabaseUrl(config.postgresSuperuserPassword),
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    for (const staff of FIXTURE_STAFF) {
      await seedStaff(client, staff);
    }
    await seedReminderFixture(client);
    await seedAccountingFixture(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
