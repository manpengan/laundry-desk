/**
 * Query HTTP + executeQuery (memory). Opt-in PG covered in bus-pg-smoke extension.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeQuery } from "../bus/execute-query.js";
import { createM1QueryRegistry } from "../bus/query-registry.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
  registerPlatformQueryHandlers,
} from "../platform/index.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: DEVICE,
  via: "ui" as const,
  permissions: Object.freeze(["settings_admin", "staff_read"]),
});

test("createM1QueryRegistry lists platform query names", () => {
  const registry = createM1QueryRegistry();
  const names = registry.names();
  assert.ok(names.includes("platform.settings.get"));
  assert.ok(names.includes("platform.store_features.get"));
  assert.ok(names.includes("platform.audit.list"));
  assert.ok(!names.includes("platform.settings.set"));
});

test("executeQuery settings.get returns values from memory store", async () => {
  const deps = Object.freeze({
    settings: createMemorySettingsStore({
      "store.name": JSON.stringify("宏发总店"),
    }),
    features: createMemoryFeaturesStore(),
    audit: createMemoryAuditQueryStore(),
  });
  const registry = createM1QueryRegistry();
  registerPlatformQueryHandlers(registry, deps);
  const client = new FakeSqlClient();

  const result = await executeQuery(
    client,
    TENANT,
    "platform.settings.get",
    { keys: ["store.name", "missing"] },
    { registry, actor: ACTOR },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.execution, "executed");
    assert.deepEqual(result.data.result, {
      values: { "store.name": JSON.stringify("宏发总店") },
    });
  }
});

test("executeQuery rejects unknown query name", async () => {
  const registry = createM1QueryRegistry();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "platform.nope",
    {},
    { registry, actor: ACTOR },
  );
  assert.equal(result.ok, false);
});

test("POST /v1/queries/platform.settings.get over HTTP (memory)", async () => {
  const runtime = await createMemoryLocalRuntime();
  // Seed a setting via memory platform store used by runtime
  await runtime.platform.settings.setMany([
    { key: "store.name", value_json: JSON.stringify("HTTP Demo") },
  ]);
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(login.statusCode, 200);
  const token = (login.json() as { data: { access_token: string } }).data.access_token;

  // Memory settings pre-seeded above; R5 set is blocked without step-up — query still works.
  const getRes = await app.inject({
    method: "POST",
    url: "/v1/queries/platform.settings.get",
    headers: { authorization: `Bearer ${token}` },
    payload: { keys: ["store.name"] },
  });
  assert.equal(getRes.statusCode, 200, getRes.body);
  const body = getRes.json() as {
    ok: boolean;
    data: { result: { values: Record<string, string> } };
  };
  assert.equal(body.ok, true);
  assert.equal(body.data.result.values["store.name"], JSON.stringify("HTTP Demo"));

  await app.close();
});
