import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import { createPgCatalogStore } from "../catalog/pg-catalog-store.js";
import { createPgOrderStore } from "./pg-order-store.js";

const urls = resolvePgUrls();
test(
  "PG receipt and hold preserve selected catalog identity, legacy ambiguity and renamed history",
  { skip: !urls },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    try {
      const tenant = await seedMigrationTenant(admin);
      const catalogId = randomUUID();
      await admin.query(
        `INSERT INTO catalog_items(id,org_id,store_id,code,name,service_code,category_code,unit_price_cents,is_active,sort_order,created_at,updated_at)
      VALUES($1,$2,$3,'snapshot-coat','收衣时大衣名称','wash','coat',1000,true,0,now(),now())`,
        [catalogId, tenant.orgId, tenant.storeId],
      );
      const store = createPgOrderStore(app);
      const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({
        order: {
          store,
          catalog: createPgCatalogStore(app, tenant),
          now: () => Math.floor(Date.now() / 1000),
        },
      });
      const actor = {
        staffId: tenant.staffId!,
        deviceId: null,
        via: "ui" as const,
        permissions: ["order_write", "order_read", "payment_write"],
      };
      const command = (
        name: "order.receive" | "order.hold",
        lines: readonly object[],
        draftId?: string,
      ) =>
        withPoolClient(app, (client) =>
          executeCommand(
            client,
            tenant,
            name,
            {
              lines,
              ...(draftId === undefined ? {} : { draft_id: draftId }),
            },
            { registry, actor, chainHooks },
          ),
        );
      const receive = async (code: string | undefined = "snapshot-coat") => {
        const result = await withPoolClient(app, (client) =>
          executeCommand(
            client,
            tenant,
            "order.receive",
            {
              lines: [
                {
                  service_code: "wash",
                  category_code: "coat",
                  qty: 1,
                  ...(code === undefined ? {} : { catalog_code: code }),
                },
              ],
              initial_payment: { amount_cents: 0, method: "cash" },
            },
            { registry, actor, chainHooks },
          ),
        );
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) throw new Error("receive failed");
        return (result.data.result as { order_id: string }).order_id;
      };
      const first = await receive();
      await admin.query("UPDATE catalog_items SET name='后来改名大衣' WHERE id=$1", [catalogId]);
      const second = await receive();
      assert.equal(
        (await store.getOrder(tenant.orgId, tenant.storeId, first))?.lines[0]?.catalog_name,
        "收衣时大衣名称",
      );
      assert.equal(
        (await store.getOrder(tenant.orgId, tenant.storeId, first))?.lines[0]?.catalog_code,
        "snapshot-coat",
      );
      assert.equal(
        (await store.getOrder(tenant.orgId, tenant.storeId, second))?.lines[0]?.catalog_name,
        "后来改名大衣",
      );
      const read = await withPoolClient(app, (client) =>
        executeQuery(
          client,
          tenant,
          "order.get",
          { order_id: first },
          { registry: queryRegistry, actor },
        ),
      );
      assert.equal(read.ok, true);
      if (!read.ok) throw new Error("read failed");
      const detail = read.data.result as {
        garments: Array<{ catalog_name: string; catalog_code: string }>;
        lines: Array<{ catalog_name: string; catalog_code: string }>;
      };
      assert.equal(detail.lines[0]?.catalog_name, "收衣时大衣名称");
      assert.equal(detail.garments[0]?.catalog_name, "收衣时大衣名称");
      assert.equal(detail.lines[0]?.catalog_code, "snapshot-coat");
      assert.equal(detail.garments[0]?.catalog_code, "snapshot-coat");
      await admin.query(
        `INSERT INTO catalog_items(id,org_id,store_id,code,name,service_code,category_code,unit_price_cents,is_active,sort_order,created_at,updated_at)
        VALUES($1,$2,$3,'snapshot-alias','不同名称同价大衣','wash','coat',1000,true,1,now(),now())`,
        [randomUUID(), tenant.orgId, tenant.storeId],
      );
      const alias = await receive("snapshot-alias");
      assert.equal(
        (await store.getOrder(tenant.orgId, tenant.storeId, alias))?.lines[0]?.catalog_name,
        "不同名称同价大衣",
      );
      const legacy = await command("order.receive", [
        { service_code: "wash", category_code: "coat", qty: 1 },
      ]);
      assert.equal(legacy.ok, true);
      if (!legacy.ok) throw new Error("legacy receive failed");
      const legacyOrder = await store.getOrder(
        tenant.orgId,
        tenant.storeId,
        (legacy.data.result as { order_id: string }).order_id,
      );
      assert.equal(legacyOrder?.lines[0]?.catalog_name, null);
      assert.equal(legacyOrder?.lines[0]?.catalog_code, null);
      const lines = [
        { service_code: "wash", category_code: "coat", qty: 1, catalog_code: "snapshot-alias" },
      ];
      const held = await command("order.hold", lines);
      assert.equal(held.ok, true, JSON.stringify(held));
      if (!held.ok) throw new Error("hold failed");
      const heldId = (held.data.result as { draft_id: string }).draft_id;
      assert.equal(
        (await store.getOrder(tenant.orgId, tenant.storeId, heldId))?.lines[0]?.catalog_code,
        "snapshot-alias",
      );
      await admin.query(
        "UPDATE catalog_items SET name='确认开单时名称' WHERE org_id=$1 AND code='snapshot-alias'",
        [tenant.orgId],
      );
      const confirmed = await command("order.receive", lines, heldId);
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
      assert.equal(
        (await store.getOrder(tenant.orgId, tenant.storeId, heldId))?.lines[0]?.catalog_name,
        "确认开单时名称",
      );
      for (const bad of [
        { ...lines[0], service_code: "dry" },
        { ...lines[0], catalog_code: "unknown-code" },
        { ...lines[0], catalog_name: "伪造名称" },
      ])
        assert.equal((await command("order.receive", [bad])).ok, false);
      await admin.query("UPDATE catalog_items SET name='   ' WHERE id=$1", [catalogId]);
      const blank = await command("order.receive", [
        { ...lines[0], catalog_code: "snapshot-coat" },
      ]);
      assert.equal(blank.ok, false);
      if (!blank.ok) assert.equal(blank.error.code, "RESOURCE_UNAVAILABLE");
      await admin.query(
        "UPDATE catalog_items SET is_active=false WHERE org_id=$1 AND code='snapshot-alias'",
        [tenant.orgId],
      );
      assert.equal((await command("order.receive", lines)).ok, false);
    } finally {
      await app.end();
      await admin.end();
    }
  },
);
