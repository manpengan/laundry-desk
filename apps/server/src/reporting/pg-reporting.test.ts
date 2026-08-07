import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgAccountingSource } from "../accounting/pg-source.js";
import { createPgOrderStore } from "../order/pg-order-store.js";
import type { GarmentRecord, OrderRecord } from "../order/types.js";
import { createPgOwnerDashboardSource } from "./pg-source.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;
const BUSINESS_DATE = "2097-04-18";
const NOW = new Date("2097-04-18T18:30:00.000Z");
const DAY_STARTED_AT = new Date("2097-04-17T19:00:00.000Z");
const PICKED_AT = new Date("2097-04-17T20:00:00.000Z");
const OVERDUE_CREATED_AT = new Date("2097-03-17T18:30:00.000Z");

type StoreSeed = Readonly<{
  storeId: string;
  code: string;
  incomeCents: number;
  receivableCents: number;
  overdueGarmentCount: number;
}>;

async function seedOrder(
  client: PgPoolClient,
  seed: StoreSeed,
  input: Readonly<{
    status: "open";
    balanceCents: number;
    paidCents: number;
    createdAt: Date;
    businessDate: string;
    garmentStatus: "picked_up" | "ready";
    garmentCount: number;
    recordPickup: boolean;
  }>,
): Promise<string> {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await client.query(
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, status,
       subtotal_cents, payable_cents, paid_cents, balance_cents,
       created_at, updated_at, created_by_staff_id, business_date
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, $6, $7, $8, $9::timestamptz, $9::timestamptz, $10::uuid, $11
     )`,
    [
      orderId,
      DEMO_ORG_ID,
      seed.storeId,
      `${seed.code}-${orderId.slice(0, 8)}`,
      input.status,
      input.paidCents + input.balanceCents,
      input.paidCents,
      input.balanceCents,
      input.createdAt.toISOString(),
      DEMO_ADMIN_ID,
      input.businessDate,
    ],
  );
  await client.query(
    `INSERT INTO order_lines (
       id, org_id, store_id, order_id, line_index, service_code,
       category_code, unit_price_cents, qty, line_total_cents
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'wash', 'coat', 100, $5, $5 * 100)`,
    [lineId, DEMO_ORG_ID, seed.storeId, orderId, input.garmentCount],
  );
  for (let index = 0; index < input.garmentCount; index += 1) {
    const garmentId = randomUUID();
    await client.query(
      `INSERT INTO garments (
         id, org_id, store_id, order_id, order_line_id, seq, barcode,
         service_code, category_code, unit_price_cents, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
                 'wash', 'coat', 100, $8)`,
      [
        garmentId,
        DEMO_ORG_ID,
        seed.storeId,
        orderId,
        lineId,
        index + 1,
        `${seed.code}-${garmentId}`,
        input.garmentStatus,
      ],
    );
    if (input.recordPickup) {
      await client.query(
        `INSERT INTO garment_status_log (
           id, org_id, store_id, order_id, garment_id,
           from_status, to_status, reason, staff_id, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'ready', 'picked_up', 'pickup_verified', $6::uuid, $7::timestamptz)`,
        [
          randomUUID(),
          DEMO_ORG_ID,
          seed.storeId,
          orderId,
          garmentId,
          DEMO_ADMIN_ID,
          PICKED_AT.toISOString(),
        ],
      );
    }
  }
  return orderId;
}

async function seedStore(adminPool: PgPool, seed: StoreSeed): Promise<string> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'Asia/Shanghai', now(), now())`,
      [seed.storeId, DEMO_ORG_ID, seed.code, `Owner dashboard ${seed.code}`],
    );
    const currentOrderId = await seedOrder(client, seed, {
      status: "open",
      balanceCents: seed.receivableCents,
      paidCents: seed.incomeCents,
      createdAt: DAY_STARTED_AT,
      businessDate: BUSINESS_DATE,
      garmentStatus: "picked_up",
      garmentCount: 1,
      recordPickup: true,
    });
    await client.query(
      `INSERT INTO payments (
         id, org_id, store_id, order_id, method, amount_cents, kind,
         staff_id, at, business_date
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', $5, 'pay',
                 $6::uuid, $7::timestamptz, $8)`,
      [
        randomUUID(),
        DEMO_ORG_ID,
        seed.storeId,
        currentOrderId,
        seed.incomeCents,
        DEMO_ADMIN_ID,
        PICKED_AT.toISOString(),
        BUSINESS_DATE,
      ],
    );
    await seedOrder(client, seed, {
      status: "open",
      balanceCents: 0,
      paidCents: 0,
      createdAt: OVERDUE_CREATED_AT,
      businessDate: "2097-03-17",
      garmentStatus: "ready",
      garmentCount: seed.overdueGarmentCount,
      recordPickup: false,
    });
    const draftId = randomUUID();
    await client.query(
      `INSERT INTO orders (
         id, org_id, store_id, status,
         subtotal_cents, payable_cents, paid_cents, balance_cents,
         created_at, updated_at, created_by_staff_id, business_date
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'draft',
         0, 0, 0, 0,
         $4::timestamptz, $4::timestamptz, $5::uuid, '2097-03-17'
       )`,
      [draftId, DEMO_ORG_ID, seed.storeId, OVERDUE_CREATED_AT.toISOString(), DEMO_ADMIN_ID],
    );
    await client.query("COMMIT");
    return draftId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function promoteOldDraft(appPool: PgPool, storeId: string, draftId: string): Promise<void> {
  const openedAt = Math.floor(NOW.getTime() / 1_000);
  const line = Object.freeze({
    line_index: 0,
    service_code: "wash",
    category_code: "coat",
    unit_price_cents: 100,
    qty: 1,
    line_total_cents: 100,
    color: null,
    brand: null,
  });
  const order: OrderRecord = Object.freeze({
    order_id: draftId,
    org_id: DEMO_ORG_ID,
    store_id: storeId,
    ticket_no: `R-${draftId.slice(0, 8)}`,
    pickup_code: `P-${draftId.slice(0, 8)}`,
    status: "open",
    customer_id: null,
    customer_phone: null,
    customer_name: null,
    note: null,
    lines: Object.freeze([line]),
    subtotal_cents: 100,
    original_cents: 100,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 100,
    paid_cents: 100,
    balance_cents: 0,
    created_at: openedAt,
    updated_at: openedAt,
    business_date: BUSINESS_DATE,
    created_by_staff_id: DEMO_ADMIN_ID,
  });
  const garment: GarmentRecord = Object.freeze({
    garment_id: randomUUID(),
    order_id: draftId,
    org_id: DEMO_ORG_ID,
    store_id: storeId,
    line_index: 0,
    seq: 1,
    barcode: `READY${draftId.replaceAll("-", "").slice(0, 11)}`,
    service_code: line.service_code,
    category_code: line.category_code,
    unit_price_cents: line.unit_price_cents,
    color: null,
    brand: null,
    status: "ready",
    rack_zone: null,
    rack_slot: null,
  });
  const replaced = await createPgOrderStore(appPool).replaceDraft?.(
    order,
    Object.freeze([garment]),
  );
  assert.equal(replaced, true);
}

maybe(
  "real PG owner dashboard honors rollover, event pickup, receivable snapshot and tenant scope",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const currentStoreId = randomUUID();
    const otherStoreId = randomUUID();
    try {
      await seedPgTestIdentityFixture(adminPool);
      const currentDraftId = await seedStore(adminPool, {
        storeId: currentStoreId,
        code: `dash-${currentStoreId.slice(0, 8)}`,
        incomeCents: 1_200,
        receivableCents: 4_500,
        overdueGarmentCount: 2,
      });
      const otherDraftId = await seedStore(adminPool, {
        storeId: otherStoreId,
        code: `dash-${otherStoreId.slice(0, 8)}`,
        incomeCents: 99_999,
        receivableCents: 88_888,
        overdueGarmentCount: 4,
      });
      await promoteOldDraft(appPool, currentStoreId, currentDraftId);
      await promoteOldDraft(appPool, otherStoreId, otherDraftId);

      const accounting = createPgAccountingSource();
      const { queryRegistry } = createRegisteredM1Bus({
        accounting: Object.freeze({ source: accounting, timeZone: "Asia/Shanghai" }),
        reporting: Object.freeze({
          accounting,
          source: createPgOwnerDashboardSource(),
          timeZone: "Asia/Shanghai",
          rolloverHour: 3,
          now: () => NOW,
        }),
      });
      const tenant: TenantContext = Object.freeze({
        orgId: DEMO_ORG_ID,
        storeId: currentStoreId,
        staffId: DEMO_ADMIN_ID,
      });
      const actor: ActorContext = Object.freeze({
        staffId: DEMO_ADMIN_ID,
        deviceId: null,
        via: "ui",
        permissions: Object.freeze(["accounting_read"]),
      });
      const queried = await withPoolClient(appPool, (client) =>
        executeQuery(
          client,
          tenant,
          "reporting.owner_dashboard.get",
          {},
          { registry: queryRegistry, actor },
        ),
      );
      assert.equal(queried.ok, true, JSON.stringify(queried));
      if (!queried.ok) return;
      const dashboard = queried.data.result as {
        business_date: string;
        trend: Array<{
          business_date: string;
          performance_income_cents: number;
          real_income_cents: number;
        }>;
        today: {
          performance_income_cents: number;
          real_income_cents: number;
          picked_up_garment_count: number;
          new_receivable_cents: number;
          new_receivable_order_count: number;
          overdue_garment_count: number;
          overdue_order_count: number;
        };
      };
      assert.equal(dashboard.business_date, BUSINESS_DATE);
      assert.equal(dashboard.trend.length, 30);
      assert.equal(dashboard.trend[0]?.business_date, "2097-03-20");
      assert.deepEqual(dashboard.trend.at(-1), {
        business_date: BUSINESS_DATE,
        performance_income_cents: 1_200,
        real_income_cents: 1_200,
      });
      assert.deepEqual(dashboard.today, {
        performance_income_cents: 1_200,
        real_income_cents: 1_200,
        picked_up_garment_count: 1,
        new_receivable_cents: 4_500,
        new_receivable_order_count: 1,
        overdue_garment_count: 2,
        overdue_order_count: 1,
      });
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  },
);
