/**
 * M2 catalog.items.list / get over memory store + query bus.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCatalogStore, DEMO_CATALOG_ITEMS } from "../catalog/memory-catalog.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["staff_read"]),
});

function buildQueryBus() {
  const catalogStore = createMemoryCatalogStore();
  const { queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    catalog: Object.freeze({ store: catalogStore }),
  });
  return { queryRegistry, catalogStore };
}

test("query registry includes catalog skeleton names", () => {
  const { queryRegistry } = buildQueryBus();
  const names = queryRegistry.names();
  assert.ok(names.includes("catalog.items.list"));
  assert.ok(names.includes("catalog.items.get"));
  assert.ok(names.includes("platform.settings.get"));
});

test("catalog.items.list returns demo items with integer cents", async () => {
  const { queryRegistry } = buildQueryBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "catalog.items.list",
    { limit: 50 },
    { registry: queryRegistry, actor: CLERK },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const data = result.data.result as {
    items: readonly {
      code: string;
      unit_price_cents: number;
      name: string;
    }[];
    total: number;
  };
  assert.ok(data.items.length >= DEMO_CATALOG_ITEMS.length);
  assert.equal(data.total, DEMO_CATALOG_ITEMS.length);
  for (const item of data.items) {
    assert.ok(Number.isInteger(item.unit_price_cents));
    assert.ok(item.unit_price_cents >= 0);
  }
  assert.ok(data.items.some((i) => i.code === "wash_shirt"));
  assert.ok(data.items.some((i) => i.code === "dry_coat"));
});

test("catalog.items.list filters by query and respects limit", async () => {
  const { queryRegistry } = buildQueryBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "catalog.items.list",
    { query: "干洗", limit: 2 },
    { registry: queryRegistry, actor: CLERK },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const data = result.data.result as {
    items: readonly { code: string; name: string }[];
    total: number;
  };
  assert.ok(data.total >= 1);
  assert.ok(data.items.length <= 2);
  assert.ok(data.items.every((i) => i.name.includes("干洗") || i.code.startsWith("dry")));
});

test("catalog.items.get returns one row by code", async () => {
  const { queryRegistry } = buildQueryBus();
  const hit = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "catalog.items.get",
    { code: "iron_shirt" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  const body = hit.data.result as {
    item: { code: string; unit_price_cents: number } | null;
  };
  assert.equal(body.item?.code, "iron_shirt");
  assert.equal(body.item?.unit_price_cents, 800);

  const miss = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "catalog.items.get",
    { code: "no_such_item" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(miss.ok, true);
  if (!miss.ok) return;
  const missBody = miss.data.result as { item: null };
  assert.equal(missBody.item, null);
});

test("DEMO_CATALOG_ITEMS has unique codes and ASCII codes only", () => {
  const codes = DEMO_CATALOG_ITEMS.map((i) => i.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const item of DEMO_CATALOG_ITEMS) {
    assert.match(item.code, /^[a-z0-9_]+$/u);
    assert.ok(Number.isInteger(item.unit_price_cents));
  }
});
