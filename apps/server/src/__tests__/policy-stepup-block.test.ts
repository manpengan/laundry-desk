/**
 * R5 step-up fail-closed + confirm_ref resume (WYSIWYS).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

const ADMIN: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["settings_admin", "staff_read", "staff_write"]),
});

const STAFF: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["settings_admin", "staff_read"]),
});

function buildBus(pendingStore: MemoryPendingActionStore) {
  const settings = createMemorySettingsStore();
  const { registry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings,
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
  });
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, chainHooks, settings, pendingStore };
}

test("R5 settings.set without confirm_ref is blocked with POLICY_STEP_UP_REQUIRED", async () => {
  const { registry, chainHooks, pendingStore } = buildBus(new MemoryPendingActionStore());
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "pricing.min_order_cents", value_json: "1200" }],
    },
    { registry, actor: ADMIN, chainHooks, pendingStore },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "POLICY_STEP_UP_REQUIRED");
    const detail = "detail" in result.error ? result.error.detail : undefined;
    assert.equal(detail?.kind, "confirmation");
    if (detail?.kind === "confirmation") {
      assert.match(detail.confirm_ref, /^[0-9a-f-]{36}$/i);
    }
  }
});

test("self-approve cannot consume R5 step-up card", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks, settings } = buildBus(pendingStore);

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "pricing.min_order_cents", value_json: "1300" }],
    },
    { registry, actor: ADMIN, chainHooks, pendingStore },
  );
  assert.equal(first.ok, false);
  const firstDetail = !first.ok && "detail" in first.error ? first.error.detail : undefined;
  if (firstDetail?.kind !== "confirmation") {
    assert.fail("expected step-up confirmation detail");
  }
  const confirmRef = firstDetail.confirm_ref;

  const self = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {},
    {
      registry,
      actor: ADMIN,
      chainHooks,
      pendingStore,
      confirmRef,
    },
  );
  assert.equal(self.ok, false);
  if (!self.ok) {
    assert.equal(self.error.code, "POLICY_DENIED");
  }
  const values = await settings.getMany(["pricing.min_order_cents"]);
  assert.equal(values["pricing.min_order_cents"], undefined);
});

test("other staff can confirm_ref resume and execute frozen R5 args", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks, settings } = buildBus(pendingStore);

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "pricing.min_order_cents", value_json: "1400" }],
    },
    { registry, actor: ADMIN, chainHooks, pendingStore },
  );
  assert.equal(first.ok, false);
  const firstDetail = !first.ok && "detail" in first.error ? first.error.detail : undefined;
  if (firstDetail?.kind !== "confirmation") {
    assert.fail("expected step-up confirmation detail");
  }
  const confirmRef = firstDetail.confirm_ref;

  const second = await executeCommand(
    new FakeSqlClient(),
    { ...TENANT, staffId: DEMO_STAFF_A_ID },
    "platform.settings.set",
    { entries: [{ key: "pricing.min_order_cents", value_json: "9999" }] },
    {
      registry,
      actor: STAFF,
      chainHooks,
      pendingStore,
      confirmRef,
    },
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  // WYSIWYS: frozen 1400 wins over body 9999
  const values = await settings.getMany(["pricing.min_order_cents"]);
  assert.equal(values["pricing.min_order_cents"], "1400");

  // Second consume fails
  const third = await executeCommand(
    new FakeSqlClient(),
    { ...TENANT, staffId: DEMO_STAFF_A_ID },
    "platform.settings.set",
    {},
    { registry, actor: STAFF, chainHooks, pendingStore, confirmRef },
  );
  assert.equal(third.ok, false);
});
