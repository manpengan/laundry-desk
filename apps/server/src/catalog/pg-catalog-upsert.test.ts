/**
 * Real-PostgreSQL acceptance for ADR-15 price maintenance.
 *
 * The sibling pg-catalog-store.test.ts runs against a capturing pool and only
 * asserts SQL text. That is the same blind spot that let migration 0019 ship a
 * business_date CHECK which rejected every date, so the write path gets a real
 * database here: upsert must round-trip through laundry_app RLS, be idempotent
 * by code, and soft-retire without deleting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgCatalogStore } from "./pg-catalog-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

/** ADR-15 §3: price maintenance is gated by settings_admin, not order_write. */
const ADMIN_ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["settings_admin"]),
});

maybe("PG catalog upsert creates, updates by code, and soft retires", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const code = `acc-${Date.now().toString(36)}`;

  try {
    await seedPgTestIdentityFixture(adminPool);
    const store = createPgCatalogStore(appPool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
    const { registry, chainHooks } = createRegisteredM1Bus({ catalog: { store } });

    const upsert = async (overrides: Readonly<Record<string, unknown>>) => {
      const result = await withPoolClient(appPool, (sql) =>
        executeCommand(
          sql,
          TENANT,
          "catalog.item.upsert",
          {
            code,
            name: "验收洗衬衫",
            service_code: "wash",
            category_code: "accshirt",
            unit_price_cents: 1_500,
            is_active: true,
            ...overrides,
          },
          { registry, actor: ADMIN_ACTOR, chainHooks },
        ),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.ok ? (result.data.result as { code: string; created: boolean }) : null;
    };

    const created = await upsert({});
    assert.deepEqual(created, { code, created: true });

    const active = await store.listAll();
    const seeded = active.find((item) => item.code === code);
    assert.ok(seeded, "new item must appear in the active price list");
    assert.equal(seeded.unit_price_cents, 1_500);

    // Same code again: an update, not a duplicate.
    const updated = await upsert({ unit_price_cents: 1_800, name: "验收洗衬衫（调价）" });
    assert.deepEqual(updated, { code, created: false }, "upsert must be idempotent by code");
    const repriced = (await store.listAll()).find((item) => item.code === code);
    assert.equal(repriced?.unit_price_cents, 1_800);

    // Soft retire: leaves the row, drops it from the active list.
    await upsert({ unit_price_cents: 1_800, is_active: false });
    assert.equal(
      (await store.listAll()).some((item) => item.code === code),
      false,
      "retired item must leave the active price list",
    );

    const rows = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, async (tx) => {
        const stored = await tx.query<{ count: string; is_active: boolean }>(
          "SELECT count(*)::text AS count, bool_and(is_active) AS is_active FROM catalog_items WHERE code = $1",
          [code],
        );
        const audits = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM audit_log WHERE command = 'catalog.item.upsert' AND entity_id = $1",
          [code],
        );
        return Object.freeze({ stored, audits });
      }),
    );
    assert.equal(Number(rows.stored.rows[0]?.count), 1, "soft retire must not delete the row");
    assert.equal(rows.stored.rows[0]?.is_active, false);
    assert.equal(Number(rows.audits.rows[0]?.count), 3, "every price change is audited");
  } finally {
    await appPool.end();
    await adminPool.end();
  }
});
