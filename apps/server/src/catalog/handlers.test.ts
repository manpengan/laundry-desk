import assert from "node:assert/strict";
import test from "node:test";

import type { CommandHandler, HandlerContext } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { registerCatalogCommandHandlers, registerCatalogQueryHandlers } from "./handlers.js";
import type { CatalogManagedItem, CatalogStore } from "./types.js";

const ITEM: CatalogManagedItem = Object.freeze({
  code: "wash_shirt",
  name: "水洗衬衫",
  service_code: "wash",
  category_code: "shirt",
  unit_price_cents: 1_500,
  is_active: true,
  sort_order: 0,
  version: 1,
  updated_at: 1_700_000_000,
});

function context(name: string, parsed: unknown): HandlerContext {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant: Object.freeze({
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
      staffId: DEMO_STAFF_A_ID,
    }),
    actor: Object.freeze({ staffId: DEMO_STAFF_A_ID, deviceId: null, via: "ui" }),
    request: Object.freeze({ name, version: "0.1.0", input: parsed, dryRun: false }),
    parsed,
  });
}

function handlers(store: CatalogStore) {
  const map = new Map<string, CommandHandler>();
  const registry = Object.freeze({
    registerHandler: (name: string, handler: CommandHandler) => map.set(name, handler),
  });
  registerCatalogCommandHandlers(registry, { store });
  registerCatalogQueryHandlers(registry, { store });
  return map;
}

test("upsert reports a versioned reactivation and writes action-only audit metadata", async () => {
  const before = Object.freeze({ ...ITEM, is_active: false, version: 3 });
  const after = Object.freeze({ ...ITEM, version: 4 });
  const map = handlers(
    Object.freeze({
      listAll: async () => Object.freeze([]),
      upsert: async () => Object.freeze({ before, after, created: false }),
    }),
  );
  const handler = map.get("catalog.item.upsert");
  assert.ok(handler);
  const outcome = await handler(
    context("catalog.item.upsert", {
      code: ITEM.code,
      name: ITEM.name,
      service_code: ITEM.service_code,
      category_code: ITEM.category_code,
      unit_price_cents: ITEM.unit_price_cents,
      is_active: true,
      expected_version: 3,
    }),
  );
  assert.deepEqual(outcome.result, {
    code: ITEM.code,
    item: after,
    created: false,
    action: "reactivated",
  });
  const audit = JSON.parse(outcome.audit?.afterJson ?? "null");
  assert.deepEqual(audit.codes, [ITEM.code]);
  assert.equal(audit.action, "reactivated");
});

test("reorder rejects duplicate codes before the repository and maps stale snapshots", async () => {
  let repositoryCalls = 0;
  const map = handlers(
    Object.freeze({
      listAll: async () => Object.freeze([]),
      reorder: async () => {
        repositoryCalls += 1;
        return null;
      },
    }),
  );
  const handler = map.get("catalog.items.reorder");
  assert.ok(handler);
  await assert.rejects(
    handler(
      context("catalog.items.reorder", {
        items: [
          { code: ITEM.code, expected_version: 1 },
          { code: ITEM.code, expected_version: 1 },
        ],
      }),
    ),
    (error) =>
      error instanceof HandlerCommandError && error.commandError.code === "VALIDATION_FAILED",
  );
  assert.equal(repositoryCalls, 0);
  await assert.rejects(
    handler(
      context("catalog.items.reorder", {
        items: [{ code: ITEM.code, expected_version: 1 }],
      }),
    ),
    (error) =>
      error instanceof HandlerCommandError && error.commandError.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("reorder records normalization when codes match but sort positions are not contiguous", async () => {
  const before = Object.freeze([{ ...ITEM, sort_order: 4 }]);
  const after = Object.freeze([{ ...ITEM, sort_order: 0, version: 2 }]);
  const map = handlers(
    Object.freeze({
      listAll: async () => Object.freeze([]),
      reorder: async () => Object.freeze({ before, after }),
    }),
  );
  const handler = map.get("catalog.items.reorder");
  assert.ok(handler);
  const outcome = await handler(
    context("catalog.items.reorder", {
      items: [{ code: ITEM.code, expected_version: ITEM.version }],
    }),
  );
  assert.deepEqual(outcome.result, { items: after, action: "reordered" });
  assert.equal(JSON.parse(outcome.audit?.afterJson ?? "null").action, "reordered");
});

test("management and audit queries return only repository safe projections", async () => {
  const audit = Object.freeze({
    id: "audit-1",
    at_epoch_s: 1_700_000_001,
    staff_id: DEMO_STAFF_A_ID,
    action: "updated" as const,
    codes: Object.freeze([ITEM.code]),
  });
  const map = handlers(
    Object.freeze({
      listAll: async () => Object.freeze([ITEM]),
      manageList: async () => Object.freeze({ items: Object.freeze([ITEM]), total: 1 }),
      listAudit: async () => Object.freeze([audit]),
    }),
  );
  const manage = map.get("catalog.items.manage.list");
  const listAudit = map.get("catalog.audit.list");
  assert.ok(manage && listAudit);
  const managed = await manage(context("catalog.items.manage.list", { limit: 50 }));
  assert.deepEqual(managed.result, { items: [ITEM], total: 1 });
  const listed = await listAudit(
    context("catalog.audit.list", {
      from_epoch_s: 1_699_000_000,
      to_epoch_s: 1_701_000_000,
      limit: 50,
    }),
  );
  assert.deepEqual(listed.result, { items: [audit] });
  assert.equal(JSON.stringify(listed).includes("before_json"), false);
  assert.equal(JSON.stringify(listed).includes("after_json"), false);
});

test("catalog audit rejects reversed and overlong time windows before repository access", async () => {
  let calls = 0;
  const map = handlers(
    Object.freeze({
      listAll: async () => Object.freeze([]),
      listAudit: async () => {
        calls += 1;
        return Object.freeze([]);
      },
    }),
  );
  const listAudit = map.get("catalog.audit.list");
  assert.ok(listAudit);
  for (const parsed of [
    { from_epoch_s: 2, to_epoch_s: 1, limit: 50 },
    { from_epoch_s: 0, to_epoch_s: 32 * 24 * 60 * 60, limit: 50 },
  ]) {
    await assert.rejects(
      listAudit(context("catalog.audit.list", parsed)),
      (error) =>
        error instanceof HandlerCommandError && error.commandError.code === "VALIDATION_FAILED",
    );
  }
  assert.equal(calls, 0);
});
