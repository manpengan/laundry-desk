import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import {
  registerDeliveryPolicyCommandHandlers,
  registerDeliveryPolicyQueryHandlers,
  type DeliveryPolicyHandlerDeps,
} from "./handlers.js";
import { createMemoryDeliveryPolicyStore } from "./memory-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const REQUESTED = Math.floor(Date.parse("2026-01-05T01:00:00.000Z") / 1_000);
const NOW = Math.floor(Date.parse("2026-01-04T00:00:00.000Z") / 1_000);
const POLICY_INPUT = Object.freeze({
  expected_version: 0,
  accepting_appointments: true,
  minimum_lead_minutes: 120,
  maximum_advance_days: 14,
  slot_minutes: 60,
  max_appointments_per_slot: 3,
  service_areas: Object.freeze([
    Object.freeze({ code: "north", name: "北区", fee_cents: 800, is_active: true }),
  ]),
  weekly_windows: Object.freeze([
    Object.freeze({ weekday: 1, start_minute: 540, end_minute: 1_020 }),
  ]),
});

function context(
  parsed: unknown,
  tenant: TenantContext = TENANT,
  confirmation?: Readonly<{ confirmRef: string; authority: unknown }>,
) {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant,
    actor: Object.freeze({
      staffId: tenant.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: Object.freeze(["settings_admin", "delivery_read"]),
    }),
    request: Object.freeze({
      name: "delivery.policy.set",
      version: "1.0",
      input: parsed,
      dryRun: false,
      ...(confirmation === undefined ? {} : { confirmRef: confirmation.confirmRef }),
    }),
    parsed,
    ...(confirmation === undefined ? {} : { confirmationAuthority: confirmation.authority }),
  }) as unknown as Parameters<CommandHandler>[0];
}

function harness(initialFeature = false) {
  let featureEnabled = initialFeature;
  const byName = new Map<string, CommandHandler>();
  const registry = Object.freeze({
    registerHandler(name: string, handler: CommandHandler) {
      byName.set(name, handler);
    },
  });
  const store = createMemoryDeliveryPolicyStore();
  const deps: DeliveryPolicyHandlerDeps = Object.freeze({
    store,
    featureEnabled: async () => featureEnabled,
    timeZone: async () => "Asia/Taipei",
    now: () => NOW,
  });
  registerDeliveryPolicyCommandHandlers(registry, deps);
  registerDeliveryPolicyQueryHandlers(registry, deps);
  return Object.freeze({
    byName,
    deps,
    store,
    enableFeature: () => {
      featureEnabled = true;
    },
  });
}

test("policy set/get is versioned, immutable, audited and current-store scoped", async () => {
  const { byName } = harness();
  const set = byName.get("delivery.policy.set");
  const get = byName.get("delivery.policy.get");
  assert.ok(set);
  assert.ok(get);

  const outcome = await set(context(POLICY_INPUT));
  const policy = (outcome.result as { policy: { version: number } }).policy;
  assert.equal(policy.version, 1);
  assert.equal(outcome.audit?.entity, "delivery_policy");
  assert.equal(JSON.parse(outcome.audit?.afterJson ?? "{}").delivery_enabled, undefined);
  assert.deepEqual((await get(context({}))).result, { policy });

  const other = await get(
    context({}, { ...TENANT, storeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
  );
  assert.equal((other.result as { policy: { version: number } }).policy.version, 0);
  await assert.rejects(
    () => set(context(POLICY_INPUT)),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("quote handler preserves feature-off and becomes available only after feature enablement", async () => {
  const harnessed = harness();
  const set = harnessed.byName.get("delivery.policy.set");
  const quote = harnessed.byName.get("delivery.availability.quote");
  assert.ok(set);
  assert.ok(quote);
  await set(context(POLICY_INPUT));
  const input = {
    direction: "pickup",
    service_area_code: "north",
    requested_start_at: REQUESTED,
  };

  const disabled = await quote(context(input));
  assert.equal(
    (disabled.result as { quote: { reason: string } }).quote.reason,
    "delivery_disabled",
  );
  harnessed.enableFeature();
  const enabled = await quote(context(input));
  assert.deepEqual((enabled.result as { quote: unknown }).quote, {
    policy_version: 1,
    feature_enabled: true,
    can_request_appointment: true,
    reason: "available",
    direction: "pickup",
    service_area_code: "north",
    requested_start_at: REQUESTED,
    requested_end_at: REQUESTED + 3_600,
    fee_cents: 800,
    capacity_status: "not_checked",
    max_appointments_per_slot: 3,
    timezone: "Asia/Taipei",
  });
});

test("query bus enforces dedicated delivery read permission and registers both queries", async () => {
  const { deps } = harness();
  const { queryRegistry, registeredQueries } = createRegisteredM1Bus({ deliveryPolicy: deps });
  assert.deepEqual(
    registeredQueries.filter((name) => name.startsWith("delivery.")),
    ["delivery.policy.get", "delivery.availability.quote"],
  );
  const actor = (permissions: readonly string[]): ActorContext =>
    Object.freeze({
      staffId: TENANT.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: Object.freeze([...permissions]),
    });
  const denied = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "delivery.availability.quote",
    { direction: "pickup", service_area_code: "north", requested_start_at: REQUESTED },
    { registry: queryRegistry, actor: actor([]) },
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "PERMISSION_DENIED");

  const allowed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "delivery.availability.quote",
    { direction: "pickup", service_area_code: "north", requested_start_at: REQUESTED },
    { registry: queryRegistry, actor: actor(["delivery_read"]) },
  );
  assert.equal(allowed.ok, true);
  const policy = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "delivery.policy.get",
    {},
    {
      registry: queryRegistry,
      actor: actor(["delivery_read"]),
    },
  );
  assert.equal(policy.ok, true);
});

test("R5 first-hop retry reuses one frozen card and leaves policy unchanged", async () => {
  const { deps, store } = harness();
  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks } = createRegisteredM1Bus({ deliveryPolicy: deps }, pendingStore);
  const options = {
    registry,
    chainHooks,
    pendingStore,
    actor: Object.freeze({
      staffId: TENANT.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: Object.freeze(["settings_admin"]),
    }),
    idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  } as const;
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.policy.set",
    POLICY_INPUT,
    options,
  );
  const replay = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.policy.set",
    POLICY_INPUT,
    options,
  );

  assert.equal(first.ok, false);
  assert.equal(replay.ok, false);
  if (first.ok || replay.ok) return;
  assert.equal(first.error.code, "POLICY_STEP_UP_REQUIRED");
  assert.equal(replay.error.code, "POLICY_STEP_UP_REQUIRED");
  assert.equal(first.error.detail?.kind, "confirmation");
  assert.equal(replay.error.detail?.kind, "confirmation");
  if (first.error.detail?.kind !== "confirmation" || replay.error.detail?.kind !== "confirmation") {
    return;
  }
  assert.equal(first.error.detail.confirm_ref, replay.error.detail.confirm_ref);
  assert.deepEqual(first.error.detail.summary, { kind: "delivery_policy", ...POLICY_INPUT });
  assert.deepEqual(replay.error.detail.summary, first.error.detail.summary);
  assert.equal(pendingStore.size(), 1);
  assert.equal((await store.get(TENANT.orgId, TENANT.storeId)).version, 0);
});

test("confirmed policy writes require the exact server-frozen authority", async () => {
  const { byName } = harness();
  const set = byName.get("delivery.policy.set");
  assert.ok(set);
  const confirmRef = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const authority = Object.freeze({ kind: "delivery_policy", ...POLICY_INPUT });

  await assert.rejects(
    () =>
      set(
        context(POLICY_INPUT, TENANT, {
          confirmRef,
          authority: { ...authority, maximum_advance_days: 30 },
        }),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "POLICY_DENIED",
  );
  const accepted = await set(context(POLICY_INPUT, TENANT, { confirmRef, authority }));
  assert.equal((accepted.result as { policy: { version: number } }).policy.version, 1);
});
