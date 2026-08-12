import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createStoreManagementHandlers } from "./handlers.js";
import { createMemoryStoreManagementStore } from "./memory-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const UPDATED_AT = new Date("2026-08-11T02:03:04.000Z");

function actor(permissions: readonly string[] = ["store_manage"]): ActorContext {
  return Object.freeze({
    staffId: TENANT.staffId,
    deviceId: null,
    via: "ui",
    permissions,
  });
}

function context(parsed: unknown, permissions?: readonly string[]) {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor: actor(permissions),
    parsed,
  }) as unknown as Parameters<CommandHandler>[0];
}

function handlers(now: () => Date = () => UPDATED_AT) {
  const store = createMemoryStoreManagementStore({
    storeCode: "main",
    storeName: "总店",
    timeZone: "Asia/Shanghai",
    profileVersion: 3,
    updatedAt: new Date("2026-08-10T01:02:03.000Z"),
  });
  return createStoreManagementHandlers(Object.freeze({ store, now }));
}

test("authorized store list is current-session scoped and rejects client scope fields", async () => {
  const list = handlers()["store.authorized.list"];
  const outcome = await list(context({}));

  assert.deepEqual(outcome.result, {
    returned_store_count: 1,
    truncated: false,
    stores: [
      {
        store_code: "main",
        store_name: "总店",
        timezone: "Asia/Shanghai",
        profile_version: 3,
        updated_at: "2026-08-10T01:02:03.000Z",
        is_current: true,
      },
    ],
  });
  await assert.rejects(() => list(context({ org_id: TENANT.orgId })), /unrecognized/iu);
  await assert.rejects(() => list(context({ store_id: TENANT.storeId })), /unrecognized/iu);
});

test("store management requires the explicit store_manage permission", async () => {
  const current = handlers();
  for (const [name, parsed] of [
    ["store.authorized.list", {}],
    [
      "store.profile.set",
      { expected_profile_version: 3, store_name: "新总店", reason: "品牌名称更新" },
    ],
  ] as const) {
    await assert.rejects(
      () => current[name](context(parsed, [])),
      (error: unknown) =>
        error instanceof HandlerCommandError && error.commandError.code === "PERMISSION_DENIED",
    );
  }
});

test("store profile rename increments the version and emits transaction audit material", async () => {
  const current = handlers();
  const set = current["store.profile.set"];
  const outcome = await set(
    context({
      expected_profile_version: 3,
      store_name: "  城南总店  ",
      reason: "门头名称调整",
    }),
  );

  assert.deepEqual(outcome.result, {
    store: {
      store_code: "main",
      store_name: "城南总店",
      timezone: "Asia/Shanghai",
      profile_version: 4,
      updated_at: UPDATED_AT.toISOString(),
      is_current: true,
    },
  });
  assert.equal(outcome.audit?.entity, "store_profile");
  assert.equal(outcome.audit?.entityId, "main");
  assert.deepEqual(JSON.parse(outcome.audit?.beforeJson ?? "null"), {
    store_code: "main",
    store_name: "总店",
    profile_version: 3,
  });
  assert.deepEqual(JSON.parse(outcome.audit?.afterJson ?? "null"), {
    store_code: "main",
    store_name: "城南总店",
    profile_version: 4,
    reason: "门头名称调整",
  });
  assert.deepEqual(outcome.events, [
    { type: "store.profile_changed", payload: { store_code: "main", profile_version: 4 } },
  ]);

  const listed = await current["store.authorized.list"](context({}));
  assert.equal(
    (listed.result as { stores: readonly { store_name: string }[] }).stores[0]?.store_name,
    "城南总店",
  );
});

test("store profile rename fails closed for stale, unchanged and invalid timestamps", async () => {
  const set = handlers()["store.profile.set"];
  await assert.rejects(
    () =>
      set(
        context({
          expected_profile_version: 2,
          store_name: "新总店",
          reason: "版本冲突验证",
        }),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () =>
      set(
        context({
          expected_profile_version: 3,
          store_name: "总店",
          reason: "无变化验证",
        }),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
  );

  const invalidClockSet = handlers(() => new Date(Number.NaN))["store.profile.set"];
  await assert.rejects(
    () =>
      invalidClockSet(
        context({
          expected_profile_version: 3,
          store_name: "新总店",
          reason: "时钟异常验证",
        }),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "TRANSACTION_FAILED",
  );
});
