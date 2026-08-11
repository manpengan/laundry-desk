/**
 * M2 order.get over memory store + query bus (partial pickup load path).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";

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

function buildBus(orderStore = createMemoryOrderStore()) {
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore, catalog: createMemoryCatalogStore() }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore };
}

test("query registry includes order.get when order deps present", () => {
  const { queryRegistry } = buildBus();
  const names = queryRegistry.names();
  assert.ok(names.includes("order.get"));
  assert.ok(names.includes("platform.settings.get"));
  const entry = queryRegistry.get("order.get");
  assert.ok(entry);
  assert.equal(entry.definition.name, "order.get");
  assert.ok(entry.handler !== undefined);
});

test("order.get returns summary and garments with unit_price_cents", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();
  const received = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000111",
      customer_name: "张三",
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1500,
          qty: 2,
          garments: [
            {
              color: "白",
              brand: "甲牌",
              defects: ["袖口污渍"],
              accessories: ["腰带"],
              note: "单独去渍",
            },
            { color: "蓝", brand: "乙牌" },
          ],
        },
      ],
      paid_cents: 500,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: orderId },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;

  const data = result.data.result as {
    order_id: string;
    ticket_no: string;
    status: string;
    customer_phone: string | null;
    customer_name: string | null;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    note: string | null;
    pricing_policy_version: number;
    lines: readonly {
      qty: number;
      garments: readonly {
        color: string | null;
        brand: string | null;
        defects: readonly string[];
        accessories: readonly string[];
        note: string | null;
      }[];
    }[];
    garments: readonly {
      garment_id: string;
      barcode: string;
      status: string;
      line_index: number;
      seq: number;
      unit_price_cents: number;
      color: string | null;
      brand: string | null;
      defects: readonly string[];
      accessories: readonly string[];
      note: string | null;
    }[];
  };

  assert.equal(data.order_id, orderId);
  assert.match(data.ticket_no, /^\d{8}-\d{4}$/u);
  assert.equal(data.status, "open");
  assert.equal(data.customer_phone, "13800000111");
  assert.equal(data.customer_name, "张三");
  assert.equal(data.payable_cents, 3000);
  assert.equal(data.paid_cents, 500);
  assert.equal(data.balance_cents, 2500);
  assert.equal(data.note, null);
  assert.equal(data.pricing_policy_version, 0);
  assert.equal(data.lines.length, 1);
  assert.deepEqual(data.lines[0]?.garments[0], {
    color: "白",
    brand: "甲牌",
    defects: ["袖口污渍"],
    accessories: ["腰带"],
    note: "单独去渍",
    addons: [],
  });
  assert.equal(data.garments.length, 2);
  for (const g of data.garments) {
    assert.equal(typeof g.garment_id, "string");
    assert.equal(typeof g.barcode, "string");
    assert.equal(g.status, "received");
    assert.equal(g.line_index, 0);
    assert.ok(g.seq === 1 || g.seq === 2);
    assert.equal(g.unit_price_cents, 1500);
    assert.ok(Number.isInteger(g.unit_price_cents));
  }
  assert.deepEqual(
    data.garments.map((garment) => ({
      color: garment.color,
      brand: garment.brand,
      defects: garment.defects,
      accessories: garment.accessories,
      note: garment.note,
    })),
    [
      {
        color: "白",
        brand: "甲牌",
        defects: ["袖口污渍"],
        accessories: ["腰带"],
        note: "单独去渍",
      },
      { color: "蓝", brand: "乙牌", defects: [], accessories: [], note: null },
    ],
  );
});

test("order.get returns a resumable draft snapshot and the same id can open once", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();
  const held = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.hold",
    {
      customer_phone: "13800000112",
      customer_name: "挂单顾客",
      note: "晚点回来",
      urgent: true,
      lines: [
        {
          service_code: "dry",
          category_code: "coat",
          qty: 1,
          garments: [
            {
              color: "黑",
              brand: "示例牌",
              defects: ["左袖破损"],
              accessories: ["腰带"],
              note: "保持衣架",
            },
          ],
        },
      ],
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(held.ok, true, JSON.stringify(held));
  if (!held.ok) return;
  const draftId = (held.data.result as { draft_id: string }).draft_id;

  const draft = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: draftId },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(draft.ok, true, JSON.stringify(draft));
  if (!draft.ok) return;
  const snapshot = draft.data.result as {
    status: string;
    ticket_no: string | null;
    note: string | null;
    lines: readonly {
      garments: readonly {
        color: string | null;
        brand: string | null;
        defects: readonly string[];
        accessories: readonly string[];
        note: string | null;
        addons: readonly { code: string }[];
      }[];
    }[];
    garments: readonly unknown[];
  };
  assert.equal(snapshot.status, "draft");
  assert.equal(snapshot.ticket_no, null);
  assert.equal(snapshot.note, "晚点回来");
  assert.deepEqual(snapshot.lines[0]?.garments[0], {
    color: "黑",
    brand: "示例牌",
    defects: ["左袖破损"],
    accessories: ["腰带"],
    note: "保持衣架",
    addons: [],
  });
  assert.deepEqual(snapshot.garments, []);

  const opened = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      draft_id: draftId,
      customer_phone: "13800000112",
      customer_name: "挂单顾客",
      note: "晚点回来",
      lines: [
        {
          service_code: "dry",
          category_code: "coat",
          qty: 1,
          garments: snapshot.lines[0]?.garments.map((garment) => ({
            ...(garment.color === null ? {} : { color: garment.color }),
            ...(garment.brand === null ? {} : { brand: garment.brand }),
            defects: garment.defects,
            accessories: garment.accessories,
            ...(garment.note === null ? {} : { note: garment.note }),
            addon_codes: garment.addons.map((addon) => addon.code),
          })),
        },
      ],
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) return;
  assert.equal((opened.data.result as { order_id: string }).order_id, draftId);

  const formal = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: draftId },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(formal.ok, true, JSON.stringify(formal));
  if (!formal.ok) return;
  const formalResult = formal.data.result as {
    status: string;
    garments: readonly { defects: readonly string[]; accessories: readonly string[] }[];
  };
  assert.equal(formalResult.status, "open");
  assert.deepEqual(formalResult.garments[0]?.defects, ["左袖破损"]);
  assert.deepEqual(formalResult.garments[0]?.accessories, ["腰带"]);
});

test("order.get missing order is RESOURCE_UNAVAILABLE", async () => {
  const { queryRegistry } = buildBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
});

test("order.get rejects invalid order_id", async () => {
  const { queryRegistry } = buildBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: "not-a-uuid" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
});
