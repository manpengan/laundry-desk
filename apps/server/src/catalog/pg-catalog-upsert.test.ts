/** Real-PostgreSQL acceptance for ADR-39 catalog governance. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgCatalogStore } from "./pg-catalog-store.js";
import type { CatalogManagedItem } from "./types.js";

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

const ADMIN_ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["settings_admin", "audit_read"]),
});

type GovernanceResult = Readonly<{
  code: string;
  item: CatalogManagedItem;
  created: boolean;
  action: string;
}>;

maybe("PG catalog versions update, reorder, retire, reactivate and audit atomically", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const suffix = Date.now().toString(36);
  const codes = [`acc_a_${suffix}`, `acc_b_${suffix}`] as const;
  const otherStoreId = randomUUID();
  const otherCode = `acc_other_${suffix}`;

  try {
    await seedPgTestIdentityFixture(adminPool);
    await adminPool.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Catalog isolation fixture', 'Asia/Shanghai', now(), now())`,
      [otherStoreId, DEMO_ORG_ID, `catalog-${suffix}`],
    );
    await adminPool.query(
      `INSERT INTO catalog_items (
         id, org_id, store_id, code, name, service_code, category_code,
         unit_price_cents, is_active, sort_order, created_at, updated_at
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'Other store item','wash','other',990,true,0,now(),now())`,
      [randomUUID(), DEMO_ORG_ID, otherStoreId, otherCode],
    );
    const store = createPgCatalogStore(appPool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
    const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({ catalog: { store } });

    const command = (name: string, input: unknown): Promise<CommandResult> =>
      withPoolClient(appPool, (sql) =>
        executeCommand(sql, TENANT, name, input, {
          registry,
          actor: ADMIN_ACTOR,
          chainHooks,
        }),
      );
    const query = async (name: string, input: unknown): Promise<unknown> => {
      const result = await withPoolClient(appPool, (sql) =>
        executeQuery(sql, TENANT, name, input, { registry: queryRegistry, actor: ADMIN_ACTOR }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.ok ? result.data.result : null;
    };
    const upsertInput = (
      code: string,
      expectedVersion: number,
      overrides: Readonly<Record<string, unknown>> = {},
    ) =>
      Object.freeze({
        code,
        name: `验收 ${code}`,
        service_code: "wash",
        category_code: "accshirt",
        unit_price_cents: 1_500,
        is_active: true,
        expected_version: expectedVersion,
        ...overrides,
      });
    const upsert = async (
      code: string,
      expectedVersion: number,
      overrides: Readonly<Record<string, unknown>> = {},
    ): Promise<GovernanceResult> => {
      const result = await command(
        "catalog.item.upsert",
        upsertInput(code, expectedVersion, overrides),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result.ok ? result.data.result : null) as GovernanceResult;
    };
    const managed = async () =>
      (await query("catalog.items.manage.list", { limit: 200 })) as {
        items: readonly CatalogManagedItem[];
        total: number;
      };

    const first = await upsert(codes[0], 0);
    const second = await upsert(codes[1], 0);
    assert.equal(first.created, true);
    assert.equal(first.item.version, 1);
    assert.equal(second.item.version, 1);

    const hiddenOtherStore = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, (tx) =>
        tx.query<{ code: string }>("SELECT code FROM catalog_items WHERE code=$1", [otherCode]),
      ),
    );
    assert.equal(hiddenOtherStore.rows.length, 0);

    await assert.rejects(
      withPoolClient(appPool, (sql) =>
        withTenantTransaction(sql, TENANT, (tx) =>
          tx.query("DELETE FROM catalog_items WHERE code=$1", [codes[0]]),
        ),
      ),
      /permission denied for table catalog_items/iu,
    );

    const concurrent = await Promise.all([
      command(
        "catalog.item.upsert",
        upsertInput(codes[0], 1, { name: "并发候选 A", unit_price_cents: 1_700 }),
      ),
      command(
        "catalog.item.upsert",
        upsertInput(codes[0], 1, { name: "并发候选 B", unit_price_cents: 1_750 }),
      ),
    ]);
    const concurrentSuccesses = concurrent.filter((result) => result.ok);
    const concurrentFailures = concurrent.filter((result) => !result.ok);
    assert.equal(concurrentSuccesses.length, 1);
    assert.equal(concurrentFailures.length, 1);
    assert.equal(concurrentFailures[0]?.ok, false);
    if (concurrentFailures[0]?.ok === false) {
      assert.equal(concurrentFailures[0].error.code, "IDEMPOTENCY_CONFLICT");
    }
    const concurrentWinner = concurrentSuccesses[0];
    assert.equal(concurrentWinner?.ok, true);
    if (concurrentWinner?.ok) {
      assert.equal((concurrentWinner.data.result as GovernanceResult).item.version, 2);
    }

    const stale = await command("catalog.item.upsert", {
      code: codes[0],
      name: "陈旧覆盖",
      service_code: "wash",
      category_code: "accshirt",
      unit_price_cents: 9_999,
      is_active: true,
      expected_version: 1,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "IDEMPOTENCY_CONFLICT");

    const repriced = await upsert(codes[0], 2, { unit_price_cents: 1_800 });
    assert.equal(repriced.item.version, 3);
    assert.equal(repriced.action, "updated");

    const beforeReorder = await managed();
    const originalCodes = beforeReorder.items
      .filter((item) => item.is_active)
      .map((item) => item.code);
    const swappedCodes = [...originalCodes];
    const firstIndex = swappedCodes.indexOf(codes[0]);
    const secondIndex = swappedCodes.indexOf(codes[1]);
    assert.ok(firstIndex >= 0 && secondIndex >= 0);
    [swappedCodes[firstIndex], swappedCodes[secondIndex]] = [
      swappedCodes[secondIndex]!,
      swappedCodes[firstIndex]!,
    ];
    const versionByCode = new Map(beforeReorder.items.map((item) => [item.code, item.version]));
    const reordered = await command("catalog.items.reorder", {
      items: swappedCodes.map((code) => ({ code, expected_version: versionByCode.get(code) })),
    });
    assert.equal(reordered.ok, true, JSON.stringify(reordered));
    const afterReorder = await managed();
    assert.deepEqual(
      afterReorder.items.filter((item) => item.is_active).map((item) => item.code),
      swappedCodes,
    );

    const staleOrder = await command("catalog.items.reorder", {
      items: swappedCodes.map((code) => ({ code, expected_version: versionByCode.get(code) })),
    });
    assert.equal(staleOrder.ok, false);
    if (!staleOrder.ok) assert.equal(staleOrder.error.code, "IDEMPOTENCY_CONFLICT");

    const retired = await upsert(
      codes[0],
      afterReorder.items.find((item) => item.code === codes[0])?.version ?? -1,
      { unit_price_cents: 1_800, is_active: false },
    );
    assert.equal(retired.action, "retired");
    assert.equal(
      (await store.listAll()).some((item) => item.code === codes[0]),
      false,
    );
    const inactive = (await managed()).items.find((item) => item.code === codes[0]);
    assert.equal(inactive?.is_active, false);

    const reactivated = await upsert(codes[0], inactive?.version ?? -1, {
      unit_price_cents: 1_800,
      is_active: true,
    });
    assert.equal(reactivated.action, "reactivated");
    assert.ok(reactivated.item.version > retired.item.version);

    const auditNow = Math.floor(Date.now() / 1_000);
    const audits = (await query("catalog.audit.list", {
      from_epoch_s: auditNow - 30 * 24 * 60 * 60,
      to_epoch_s: auditNow + 60,
      code: codes[0],
      limit: 50,
    })) as { items: readonly Readonly<Record<string, unknown>>[] };
    const actions = audits.items.map((item) => item.action);
    for (const action of ["created", "updated", "reordered", "retired", "reactivated"]) {
      assert.ok(actions.includes(action), `missing ${action} audit`);
    }
    assert.equal(JSON.stringify(audits).includes("before_json"), false);
    assert.equal(JSON.stringify(audits).includes("after_json"), false);

    const committed = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, async (tx) => {
        const rows = await tx.query<{ count: string; min_version: number }>(
          `SELECT count(*)::text AS count, min(version)::integer AS min_version
             FROM catalog_items WHERE code = ANY($1::text[])`,
          [codes],
        );
        const auditRows = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_log
            WHERE command IN ('catalog.item.upsert','catalog.items.reorder')
              AND (entity_id = ANY($1::text[]) OR after_json LIKE $2)`,
          [codes, `%${codes[0]}%`],
        );
        return Object.freeze({ rows, auditRows });
      }),
    );
    assert.equal(Number(committed.rows.rows[0]?.count), 2);
    assert.ok((committed.rows.rows[0]?.min_version ?? 0) >= 1);
    assert.ok(Number(committed.auditRows.rows[0]?.count) >= 6);
  } finally {
    try {
      await adminPool.query("BEGIN");
      await adminPool.query(
        `DELETE FROM audit_log
          WHERE org_id=$1::uuid AND store_id=$2::uuid
            AND command IN ('catalog.item.upsert','catalog.items.reorder')
            AND (entity_id = ANY($3::text[]) OR after_json LIKE ANY($4::text[]))`,
        [DEMO_ORG_ID, DEMO_STORE_ID, codes, codes.map((code) => `%${code}%`)],
      );
      await adminPool.query(
        "DELETE FROM catalog_items WHERE org_id=$1::uuid AND store_id=$2::uuid AND code=ANY($3::text[])",
        [DEMO_ORG_ID, DEMO_STORE_ID, codes],
      );
      await adminPool.query("DELETE FROM catalog_items WHERE store_id=$1::uuid", [otherStoreId]);
      await adminPool.query("DELETE FROM stores WHERE id=$1::uuid", [otherStoreId]);
      await adminPool.query("COMMIT");
    } catch (error) {
      await adminPool.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  }
});
