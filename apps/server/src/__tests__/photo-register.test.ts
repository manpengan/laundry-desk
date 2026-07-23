/**
 * M3 skeleton: photo.register + photo.list_by_order over memory store.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryPhotoStore } from "../photo/memory-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["order_write", "staff_read"]),
});

const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GARMENT_ID = "11111111-2222-4333-8444-555555555555";
const FIXED_NOW = 1_721_606_400;

function buildBus(fixedNow = () => FIXED_NOW) {
  const photoStore = createMemoryPhotoStore();
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    photo: Object.freeze({ store: photoStore, now: fixedNow }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, photoStore };
}

test("command registry includes photo.register when photo deps present", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(registry.names().includes("photo.register"));
  assert.ok(queryRegistry.names().includes("photo.list_by_order"));
  assert.ok(registry.get("photo.register")?.handler);
  assert.ok(queryRegistry.get("photo.list_by_order")?.handler);
  assert.equal(registry.get("photo.register")?.definition.risk, "R2");
  assert.equal(queryRegistry.get("photo.list_by_order")?.definition.risk, "R1");
});

test("photo.list_by_order returns empty list when none registered", async () => {
  const { queryRegistry } = buildBus();
  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "photo.list_by_order",
    { order_id: ORDER_ID },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as { photos: unknown[] };
  assert.deepEqual(body.photos, []);
});

test("photo.register stores metadata and list_by_order returns it", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

  const registered = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "photo.register",
    {
      order_id: ORDER_ID,
      garment_id: GARMENT_ID,
      kind: "receive",
      storage_key: "skeleton/demo.jpg",
      byte_size: 2048,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;

  const row = registered.data.result as {
    photo_id: string;
    order_id: string;
    garment_id: string;
    kind: string;
    storage_key: string;
    content_type: string;
    byte_size: number;
    taken_at: number;
    created_by_staff_id: string;
  };
  assert.equal(row.order_id, ORDER_ID);
  assert.equal(row.garment_id, GARMENT_ID);
  assert.equal(row.kind, "receive");
  assert.equal(row.storage_key, "skeleton/demo.jpg");
  assert.equal(row.content_type, "image/jpeg");
  assert.equal(row.byte_size, 2048);
  assert.equal(row.taken_at, FIXED_NOW);
  assert.equal(row.created_by_staff_id, DEMO_STAFF_A_ID);
  assert.ok(typeof row.photo_id === "string" && row.photo_id.length > 0);

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "photo.list_by_order",
    { order_id: ORDER_ID },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as { photos: Array<{ photo_id: string; byte_size: number }> };
  assert.equal(body.photos.length, 1);
  assert.equal(body.photos[0]?.photo_id, row.photo_id);
  assert.equal(body.photos[0]?.byte_size, 2048);
});

test("photo.register rejects non-positive byte_size", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const failed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "photo.register",
    {
      order_id: ORDER_ID,
      garment_id: GARMENT_ID,
      kind: "receive",
      storage_key: "k",
      byte_size: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.error.code, "VALIDATION_FAILED");
});

test("photo.register rejects invalid kind", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const failed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "photo.register",
    {
      order_id: ORDER_ID,
      garment_id: GARMENT_ID,
      kind: "blob",
      storage_key: "k",
      byte_size: 10,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.error.code, "VALIDATION_FAILED");
});
