import assert from "node:assert/strict";
import test from "node:test";

import { HandlerCommandError, type HandlerContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { createMemoryMemberStore } from "../member/memory-store.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { createMemberBenefitsHandlers } from "./handlers.js";
import { createMemoryMemberBenefitsStore } from "./memory-store.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "10000000-0000-4000-8000-000000000002";
const STAFF_ID = "10000000-0000-4000-8000-000000000003";
const ASSET_ID = "10000000-0000-4000-8000-000000000004";
const ORDER_ID = "10000000-0000-4000-8000-000000000005";
const NOW = 1_786_089_600;

function createStore() {
  return createMemoryMemberBenefitsStore({
    orgId: ORG_ID,
    memberStore: createMemoryMemberStore({ customerIds: [] }),
    orderStore: createMemoryOrderStore(),
    newId: () => "20000000-0000-4000-8000-000000000001",
  });
}

function context(
  name: string,
  parsed: Readonly<Record<string, unknown>>,
  permissions: readonly string[],
): HandlerContext {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant: Object.freeze({ orgId: ORG_ID, storeId: STORE_ID, staffId: STAFF_ID }),
    actor: Object.freeze({
      staffId: STAFF_ID,
      deviceId: null,
      via: "ui" as const,
      permissions,
    }),
    request: Object.freeze({ name, version: "0.1.0", input: parsed, dryRun: false }),
    parsed,
  });
}

test("benefit definition audit records every coupon rule value", async () => {
  const parsed = Object.freeze({
    definition: Object.freeze({
      kind: "coupon_type",
      expected_version: 0,
      code: "welcome",
      name: "迎新券",
      discount_cents: 500,
      min_order_cents: 1_000,
      valid_days: 30,
      status: "active",
    }),
  });
  const outcome = await createMemberBenefitsHandlers({
    store: createStore(),
    order: Object.freeze({ now: () => NOW, timeZone: "UTC", rolloverHour: 0 }),
  })["member.benefit_definition.upsert"]!(
    context("member.benefit_definition.upsert", parsed, ["member_rule_write"]),
  );
  assert.ok(outcome.audit?.afterJson);
  assert.deepEqual(JSON.parse(outcome.audit.afterJson), {
    kind: "coupon_type",
    code: "welcome",
    name: "迎新券",
    discount_cents: 500,
    min_order_cents: 1_000,
    valid_days: 30,
    status: "active",
    version: 1,
    note: null,
  });
});

test("coupon consume locks and rejects a closed business day before touching the asset", async () => {
  const calls: string[] = [];
  const handlers = createMemberBenefitsHandlers({
    store: createStore(),
    order: Object.freeze({
      now: () => NOW,
      timeZone: "UTC",
      rolloverHour: 0,
      lockBusinessDay: async () => {
        calls.push("lock");
      },
      isBusinessDayClosed: async () => {
        calls.push("check");
        return true;
      },
    }),
  });
  const parsed = Object.freeze({
    asset: Object.freeze({ asset_kind: "coupon", asset_id: ASSET_ID, order_id: ORDER_ID }),
  });
  await assert.rejects(
    () =>
      handlers["member.asset.consume"]!(context("member.asset.consume", parsed, ["order_write"])),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "SHIFT_CLOSED",
  );
  assert.deepEqual(calls, ["lock", "check"]);
});
