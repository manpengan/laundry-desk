import assert from "node:assert/strict";
import test from "node:test";

import type { CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryPricingPolicyStore } from "./memory-store.js";
import { registerPricingCommandHandlers, registerPricingQueryHandlers } from "./handlers.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

function context(parsed: unknown, tenant: TenantContext = TENANT) {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant,
    actor: Object.freeze({
      staffId: tenant.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: Object.freeze(["settings_admin"]),
    }),
    parsed,
  }) as unknown as Parameters<CommandHandler>[0];
}

function handlers() {
  const byName = new Map<string, CommandHandler>();
  const registry = Object.freeze({
    registerHandler(name: string, handler: CommandHandler) {
      byName.set(name, handler);
    },
  });
  const store = createMemoryPricingPolicyStore();
  const deps = Object.freeze({ store, now: () => 1_700_000_000 });
  registerPricingCommandHandlers(registry, deps);
  registerPricingQueryHandlers(registry, deps);
  return { byName, store };
}

test("pricing policy set/get is versioned, normalized and store scoped", async () => {
  const { byName } = handlers();
  const set = byName.get("pricing.policy.set");
  const get = byName.get("pricing.policy.get");
  assert.ok(set);
  assert.ok(get);

  const outcome = await set(
    context({
      expected_version: 0,
      urgent_cents: 500,
      freight_cents: 300,
      addons: [
        { code: "bag", name: "防尘袋", unit_price_cents: 100, is_active: true, sort_order: 2 },
        { code: "stain", name: "去渍", unit_price_cents: 200, is_active: true, sort_order: 1 },
      ],
    }),
  );
  const policy = (outcome.result as { policy: { version: number; addons: { code: string }[] } })
    .policy;
  assert.equal(policy.version, 1);
  assert.deepEqual(
    policy.addons.map((addon) => addon.code),
    ["stain", "bag"],
  );
  assert.equal(outcome.audit?.entity, "store_pricing_policy");

  const read = await get(context({}));
  assert.deepEqual((read.result as { policy: unknown }).policy, policy);

  const other = await get(
    context(
      {},
      Object.freeze({
        ...TENANT,
        storeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ),
  );
  assert.equal((other.result as { policy: { version: number } }).policy.version, 0);
});

test("pricing policy rejects a stale version and duplicate add-on codes", async () => {
  const { byName } = handlers();
  const set = byName.get("pricing.policy.set");
  assert.ok(set);
  const valid = {
    expected_version: 0,
    urgent_cents: 0,
    freight_cents: 0,
    addons: [],
  };
  await set(context(valid));
  await assert.rejects(
    () => set(context(valid)),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () =>
      set(
        context({
          ...valid,
          expected_version: 1,
          addons: [
            { code: "same", name: "甲", unit_price_cents: 1, is_active: true, sort_order: 0 },
            { code: "same", name: "乙", unit_price_cents: 2, is_active: true, sort_order: 1 },
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "VALIDATION_FAILED",
  );
});
