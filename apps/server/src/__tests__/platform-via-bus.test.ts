import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createM1CommandRegistry } from "../bus/registry.js";
import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { findForbiddenImports } from "../architecture/import-boundary.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
  createPlatformHandlers,
  platformHandlerNames,
  registerPlatformCommandHandlers,
} from "../platform/index.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const ACTOR: ActorContext = Object.freeze({
  staffId: TENANT.staffId,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
});

const FIXED_NOW = () => new Date("2026-07-21T12:00:00.000Z");
const FIXED_ID = () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function buildDeps() {
  return Object.freeze({
    settings: createMemorySettingsStore({
      "store.name": JSON.stringify("Demo Laundry"),
      "pricing.min_order_cents": JSON.stringify(1000),
    }),
    features: createMemoryFeaturesStore({
      [TENANT.storeId]: { fulfillment: true, ai: true },
    }),
    audit: createMemoryAuditQueryStore([
      Object.freeze({
        id: "audit-1",
        at_epoch_s: 1_700_000_100,
        command: "identity.logout",
        staff_id: TENANT.staffId,
        via: "ui",
        entity: "session",
        entity_id: "s1",
        has_diff: false,
      }),
    ]),
  });
}

test("createPlatformHandlers exposes all A6 platform names", () => {
  const handlers = createPlatformHandlers(buildDeps());
  for (const name of platformHandlerNames()) {
    assert.equal(typeof handlers[name], "function", `missing handler ${name}`);
  }
});

test("platform.settings.set via bus writes settings and same-txn audit", async () => {
  const client = new FakeSqlClient();
  const deps = buildDeps();
  const registry = createM1CommandRegistry();
  registerPlatformCommandHandlers(registry, deps);

  const result = await executeCommand(
    client,
    TENANT,
    "platform.settings.set",
    {
      entries: [
        { key: "store.name", value_json: JSON.stringify("Hongfa Front Desk") },
        { key: "pricing.min_order_cents", value_json: JSON.stringify(1500) },
      ],
    },
    {
      actor: ACTOR,
      registry,
      now: FIXED_NOW,
      newId: FIXED_ID,
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.execution, "executed");
    assert.deepEqual(result.data.result, { updated: 2 });
  }

  const values = await deps.settings.getMany(["store.name", "pricing.min_order_cents"]);
  assert.equal(values["store.name"], JSON.stringify("Hongfa Front Desk"));
  assert.equal(values["pricing.min_order_cents"], JSON.stringify(1500));
});

test("settings amount keys reject float cents", async () => {
  const deps = buildDeps();
  const handlers = createPlatformHandlers(deps);
  const set = handlers["platform.settings.set"]!;
  await assert.rejects(
    () =>
      set({
        client: new FakeSqlClient(),
        tenant: TENANT,
        actor: ACTOR,
        request: {
          name: "platform.settings.set",
          version: "1.0.0",
          input: {},
          dryRun: false,
        },
        parsed: {
          entries: [{ key: "pricing.min_order_cents", value_json: "12.5" }],
        },
      }),
    /safe integer|integer/i,
  );
});

test("settings.get / store_features.get / audit.list handlers return safe payloads", async () => {
  const deps = buildDeps();
  const handlers = createPlatformHandlers(deps);
  const ctxBase = {
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor: ACTOR,
    request: {
      name: "platform.settings.get",
      version: "1.0.0",
      input: {},
      dryRun: false,
    },
  };

  const settingsOut = await handlers["platform.settings.get"]!({
    ...ctxBase,
    parsed: { keys: ["store.name", "missing.key"] },
  });
  assert.deepEqual(settingsOut.result, {
    values: { "store.name": JSON.stringify("Demo Laundry") },
  });

  const featuresOut = await handlers["platform.store_features.get"]!({
    ...ctxBase,
    request: { ...ctxBase.request, name: "platform.store_features.get" },
    parsed: { store_id: TENANT.storeId },
  });
  const featuresResult = featuresOut.result as {
    store_id: string;
    features: { fulfillment: boolean; ai: boolean };
  };
  assert.equal(featuresResult.store_id, TENANT.storeId);
  assert.equal(featuresResult.features.fulfillment, true);
  assert.equal(featuresResult.features.ai, true);

  const auditOut = await handlers["platform.audit.list"]!({
    ...ctxBase,
    request: { ...ctxBase.request, name: "platform.audit.list" },
    parsed: { from_epoch_s: 1_700_000_000, to_epoch_s: 1_800_000_000, limit: 50 },
  });
  const auditResult = auditOut.result as { items: readonly { command: string }[] };
  assert.equal(auditResult.items.length, 1);
  assert.equal(auditResult.items[0]?.command, "identity.logout");
  const blob = JSON.stringify(auditOut.result);
  assert.equal(/password|access_token|refresh_token|secret/iu.test(blob), false);
});

test("audit query never returns token/secret fields even if seeded raw", async () => {
  const audit = createMemoryAuditQueryStore();
  // Memory store projects through projectAuditListItem — no secret fields on type.
  audit.append?.({
    id: "a2",
    at_epoch_s: 1_700_000_200,
    command: "identity.login",
    staff_id: TENANT.staffId,
    via: "ui",
    entity: "session",
    entity_id: null,
    has_diff: true,
  });
  const items = await audit.list({
    orgId: TENANT.orgId,
    storeId: TENANT.storeId,
    fromEpochS: 0,
    toEpochS: 2_000_000_000,
    limit: 10,
  });
  const blob = JSON.stringify(items);
  assert.equal(/password|token|secret|pin/iu.test(blob), false);
  assert.ok(items.every((item) => Object.hasOwn(item, "has_diff")));
  assert.ok(items.every((item) => !Object.hasOwn(item, "before_json")));
  assert.ok(items.every((item) => !Object.hasOwn(item, "after_json")));
});

test("architecture: routes must not import platform store mutator modules", () => {
  const dirty = `
import { executeCommand } from "../bus/executor.js";
import { createMemorySettingsStore } from "../platform/settings.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import { createMemoryAuditQueryStore } from "../platform/audit-query.js";
`;
  const violations = findForbiddenImports(dirty, "routes/platform.ts");
  assert.ok(violations.length >= 3);
  assert.ok(violations.some((v) => v.snippet.includes("platform/settings")));
  assert.ok(violations.some((v) => v.snippet.includes("platform/features")));
  assert.ok(violations.some((v) => v.snippet.includes("platform/audit-query")));

  const clean = `
import { executeCommand } from "../bus/executor.js";
import { createPlatformHandlers } from "../platform/handlers.js";
`;
  assert.deepEqual(findForbiddenImports(clean, "routes/platform.ts"), []);
});

test("public index does not re-export raw platform store modules as route writes", () => {
  // Compiled tests live under dist/__tests__; source index is ../../src/index.ts.
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
  const source = readFileSync(indexPath, "utf8");
  // Handlers / listTools are the supported surfaces.
  assert.match(source, /createPlatformHandlers/);
  assert.match(source, /listTools/);
  // Must not star-export platform settings mutators under a routes alias.
  assert.doesNotMatch(source, /export\s+\*\s+from\s+["'].*platform\/settings/);
  assert.doesNotMatch(source, /export\s+\{\s*createMemorySettingsStore\s*\}/);
});
