import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
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
const OVERDUE_CUTOFF = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000);
const AFTER_OVERDUE_CUTOFF = new Date(OVERDUE_CUTOFF.getTime() + 1);

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

async function setAdminRole(adminPool: PgPool, storeId: string, isActive: boolean): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `INSERT INTO staff_store_roles (
         id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'admin', $5, now(), now())`,
      [randomUUID(), DEMO_ORG_ID, storeId, DEMO_ADMIN_ID, isActive],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedOverdueBoundary(adminPool: PgPool, seed: StoreSeed): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    for (const createdAt of [OVERDUE_CUTOFF, AFTER_OVERDUE_CUTOFF]) {
      await seedOrder(client, seed, {
        status: "open",
        balanceCents: 0,
        paidCents: 0,
        createdAt,
        businessDate: "2097-03-19",
        garmentStatus: "ready",
        garmentCount: 1,
        recordPickup: false,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type PortfolioBoundaryFixture = Readonly<{
  orgId: string;
  staffId: string;
  initialStoreId: string;
  authorizedCodes: readonly string[];
  unauthorizedCode: string;
  crossOrgCode: string;
}>;

async function seedPortfolioBoundary(adminPool: PgPool): Promise<PortfolioBoundaryFixture> {
  const orgId = randomUUID();
  const staffId = randomUUID();
  const crossOrgId = randomUUID();
  const prefix = `p4-${orgId.slice(0, 8)}`;
  const stores = Object.freeze(
    Array.from({ length: 51 }, (_, index) =>
      Object.freeze({
        id: randomUUID(),
        code: `${prefix}-${String(index).padStart(2, "0")}`,
      }),
    ),
  );
  const unauthorizedCode = `${prefix}-00-hidden`;
  const crossOrgCode = `${prefix}-cross-org`;
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Portfolio boundary', now(), now()),
              ($3::uuid, $4, 'Portfolio cross org', now(), now())`,
      [orgId, `${prefix}-org`, crossOrgId, `${prefix}-cross`],
    );
    await client.query(
      `INSERT INTO staffs (
         id, org_id, username, password_hash, display_name, is_active,
         permission_version, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'test-only-hash', 'Portfolio admin', true, 1, now(), now())`,
      [staffId, orgId, `${prefix}-admin`],
    );
    for (const store of stores) {
      await client.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'Asia/Shanghai', now(), now())`,
        [store.id, orgId, store.code, `Store ${store.code}`],
      );
      await client.query(
        `INSERT INTO staff_store_roles (
           id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'admin', true, now(), now())`,
        [randomUUID(), orgId, store.id, staffId],
      );
    }
    await client.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Unauthorized store', 'Asia/Shanghai', now(), now()),
              ($4::uuid, $5::uuid, $6, 'Cross-org store', 'Asia/Shanghai', now(), now())`,
      [randomUUID(), orgId, unauthorizedCode, randomUUID(), crossOrgId, crossOrgCode],
    );
    await client.query("COMMIT");
    return Object.freeze({
      orgId,
      staffId,
      initialStoreId: stores[0]?.id ?? "",
      authorizedCodes: Object.freeze(stores.map((store) => store.code)),
      unauthorizedCode,
      crossOrgCode,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setStaffActive(
  adminPool: PgPool,
  orgId: string,
  staffId: string,
  isActive: boolean,
): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      "UPDATE staffs SET is_active = $3, updated_at = now() WHERE org_id = $1::uuid AND id = $2::uuid",
      [orgId, staffId, isActive],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

maybe(
  "real PG owner dashboard honors rollover, event pickup, receivable snapshot and tenant scope",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const currentStoreId = randomUUID();
    const otherStoreId = randomUUID();
    const hiddenStoreId = randomUUID();
    const currentCode = `dash-${currentStoreId.slice(0, 8)}`;
    const otherCode = `dash-${otherStoreId.slice(0, 8)}`;
    const hiddenCode = `dash-${hiddenStoreId.slice(0, 8)}`;
    try {
      await seedPgTestIdentityFixture(adminPool);
      const currentDraftId = await seedStore(adminPool, {
        storeId: currentStoreId,
        code: currentCode,
        incomeCents: 1_200,
        receivableCents: 4_500,
        overdueGarmentCount: 2,
      });
      const otherDraftId = await seedStore(adminPool, {
        storeId: otherStoreId,
        code: otherCode,
        incomeCents: 99_999,
        receivableCents: 88_888,
        overdueGarmentCount: 4,
      });
      await seedStore(adminPool, {
        storeId: hiddenStoreId,
        code: hiddenCode,
        incomeCents: 77_777,
        receivableCents: 66_666,
        overdueGarmentCount: 3,
      });
      await seedOverdueBoundary(adminPool, {
        storeId: currentStoreId,
        code: currentCode,
        incomeCents: 0,
        receivableCents: 0,
        overdueGarmentCount: 0,
      });
      await promoteOldDraft(appPool, currentStoreId, currentDraftId);
      await promoteOldDraft(appPool, otherStoreId, otherDraftId);
      await setAdminRole(adminPool, currentStoreId, true);
      await setAdminRole(adminPool, otherStoreId, true);
      await setAdminRole(adminPool, hiddenStoreId, false);

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
        overdue_garment_count: 3,
        overdue_order_count: 2,
      });

      for (const { kind, rowCount, expected } of [
        {
          kind: "today_pickups" as const,
          rowCount: 1,
          expected: { picked_up_garment_count: 1, picked_up_order_count: 1 },
        },
        {
          kind: "new_receivables" as const,
          rowCount: 1,
          expected: { new_receivable_cents: 4_500, new_receivable_order_count: 1 },
        },
        {
          kind: "stagnant_garments" as const,
          rowCount: 2,
          expected: { overdue_garment_count: 3, overdue_order_count: 2 },
        },
      ]) {
        const detail = await withPoolClient(appPool, (client) =>
          executeQuery(
            client,
            tenant,
            "reporting.owner_dashboard.drilldown",
            { kind },
            { registry: queryRegistry, actor },
          ),
        );
        assert.equal(detail.ok, true, JSON.stringify(detail));
        if (!detail.ok) continue;
        const result = detail.data.result as {
          kind: string;
          total_row_count: number;
          truncated: boolean;
          totals: Readonly<Record<string, number>>;
          rows: readonly Readonly<Record<string, unknown>>[];
        };
        assert.equal(result.kind, kind);
        assert.equal(result.total_row_count, rowCount);
        assert.equal(result.truncated, false);
        assert.deepEqual(result.totals, expected);
        assert.equal(result.rows.length, rowCount);
        assert.ok(result.rows.every((row) => !("customer_phone" in row) && !("order_id" in row)));
        if (kind === "stagnant_garments") {
          assert.equal(
            result.rows.some((row) => row.age_days === 30),
            true,
          );
        }
      }

      const portfolioQuery = await withPoolClient(appPool, (client) =>
        executeQuery(
          client,
          tenant,
          "reporting.owner_portfolio.get",
          {},
          { registry: queryRegistry, actor },
        ),
      );
      assert.equal(portfolioQuery.ok, true, JSON.stringify(portfolioQuery));
      if (!portfolioQuery.ok) return;
      const portfolio = portfolioQuery.data.result as {
        stores: readonly Readonly<Record<string, unknown>>[];
      };
      const byCode = new Map(portfolio.stores.map((store) => [store.store_code, store]));
      assert.equal(byCode.get(currentCode)?.performance_income_cents, 1_200);
      assert.equal(byCode.get(otherCode)?.performance_income_cents, 99_999);
      assert.equal(byCode.get(otherCode)?.new_receivable_cents, 88_888);
      assert.equal(byCode.get(otherCode)?.overdue_garment_count, 4);
      assert.equal(byCode.has(hiddenCode), false);
      assert.ok(portfolio.stores.every((store) => !("store_id" in store)));

      const reportingSource = createPgOwnerDashboardSource();
      const restorationSentinel = new Error("expected portfolio callback failure");
      await withPoolClient(appPool, (client) =>
        withTenantTransaction(
          client,
          tenant,
          async (tx) => {
            await assert.rejects(
              () =>
                reportingSource.withAuthorizedPortfolioStore(
                  {
                    client: tx,
                    tenant,
                    store: {
                      storeId: otherStoreId,
                      storeCode: otherCode,
                      storeName: `Owner dashboard ${otherCode}`,
                      timeZone: "Asia/Shanghai",
                    },
                  },
                  async () => Promise.reject(restorationSentinel),
                ),
              (error: unknown) => error === restorationSentinel,
            );
            const restored = await tx.query<{ store_id: string }>(
              "SELECT current_setting('app.store_id', true) AS store_id",
            );
            assert.equal(restored.rows[0]?.store_id, currentStoreId);
          },
          { isolation: "repeatable_read", readOnly: true },
        ),
      );
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  },
);

maybe("real PG owner portfolio bounds 51 stores and hides unauthorized tenants", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  try {
    const fixture = await seedPortfolioBoundary(adminPool);
    assert.notEqual(fixture.initialStoreId, "");
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
      orgId: fixture.orgId,
      storeId: fixture.initialStoreId,
      staffId: fixture.staffId,
    });
    const actor: ActorContext = Object.freeze({
      staffId: fixture.staffId,
      deviceId: null,
      via: "ui",
      permissions: Object.freeze(["accounting_read"]),
    });
    const query = () =>
      withPoolClient(appPool, (client) =>
        executeQuery(
          client,
          tenant,
          "reporting.owner_portfolio.get",
          {},
          {
            registry: queryRegistry,
            actor,
          },
        ),
      );

    const result = await query();
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const portfolio = result.data.result as {
      returned_store_count: number;
      truncated: boolean;
      totals: Readonly<Record<string, number>>;
      stores: readonly Readonly<Record<string, unknown>>[];
    };
    assert.equal(portfolio.returned_store_count, 50);
    assert.equal(portfolio.truncated, true);
    assert.deepEqual(
      portfolio.stores.map((store) => store.store_code),
      fixture.authorizedCodes.slice(0, 50),
    );
    assert.ok(
      Object.values(portfolio.totals).every((value) => value === 0),
      JSON.stringify(portfolio.totals),
    );
    assert.equal(
      portfolio.stores.some(
        (store) =>
          store.store_code === fixture.unauthorizedCode ||
          store.store_code === fixture.crossOrgCode ||
          "store_id" in store,
      ),
      false,
    );

    await setStaffActive(adminPool, fixture.orgId, fixture.staffId, false);
    const deactivated = await query();
    assert.equal(deactivated.ok, true, JSON.stringify(deactivated));
    if (!deactivated.ok) return;
    assert.deepEqual(deactivated.data.result, {
      generated_at: NOW.toISOString(),
      returned_store_count: 0,
      truncated: false,
      totals: {
        performance_income_cents: 0,
        real_income_cents: 0,
        picked_up_garment_count: 0,
        new_receivable_cents: 0,
        new_receivable_order_count: 0,
        overdue_garment_count: 0,
        overdue_order_count: 0,
      },
      stores: [],
    });
  } finally {
    await adminPool.end();
    await appPool.end();
  }
});
