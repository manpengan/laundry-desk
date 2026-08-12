import assert from "node:assert/strict";
import test from "node:test";

import { createMemberBenefitsJourney } from "./adr41-member-benefits-journey.mjs";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const CASH_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const BENEFIT_ORDER_ID = "44444444-4444-4444-8444-444444444444";
const TIER_ID = "55555555-5555-4555-8555-555555555555";
const PUNCH_TYPE_ID = "66666666-6666-4666-8666-666666666666";
const COUPON_TYPE_ID = "77777777-7777-4777-8777-777777777777";
const PUNCH_ID = "88888888-8888-4888-8888-888888888888";
const COUPON_ID = "99999999-9999-4999-8999-999999999999";
const POLICY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeJourneyApi() {
  const calls = [];
  let catalog = {
    tiers: [],
    points_policy: null,
    punch_types: [],
    coupon_types: [],
  };
  let benefits = {
    membership: { status: "unassigned" },
    points: { available_points: 0 },
    punch_cards: [],
    coupons: [],
  };
  const orders = new Map([
    [CASH_ORDER_ID, { order_id: CASH_ORDER_ID, status: "closed", paid_cents: 2_600 }],
  ]);
  const nextVersion = (row) => (row === undefined || row === null ? 1 : row.version + 1);
  const snapshot = () => structuredClone(catalog);
  const mutation = () => ({ benefits: structuredClone(benefits) });

  const upsertDefinition = (definition) => {
    if (definition.kind === "points_policy") {
      catalog = {
        ...catalog,
        points_policy: {
          policy_id: POLICY_ID,
          unit_cents: definition.unit_cents,
          points_per_unit: definition.points_per_unit,
          valid_days: definition.valid_days,
          status: definition.status,
          version: nextVersion(catalog.points_policy),
          note: definition.note ?? null,
        },
      };
      return { catalog: snapshot() };
    }
    const key =
      definition.kind === "tier"
        ? "tiers"
        : definition.kind === "punch_type"
          ? "punch_types"
          : "coupon_types";
    const id =
      definition.kind === "tier"
        ? TIER_ID
        : definition.kind === "punch_type"
          ? PUNCH_TYPE_ID
          : COUPON_TYPE_ID;
    const existing = catalog[key].find((row) => row.definition_id === definition.definition_id);
    const row = {
      ...definition,
      definition_id: id,
      version: nextVersion(existing),
      note: definition.note ?? null,
    };
    delete row.kind;
    delete row.expected_version;
    catalog = { ...catalog, [key]: [row] };
    return { catalog: snapshot() };
  };

  const api = Object.freeze({
    query: async (_session, name, input) => {
      calls.push({ method: "query", name, input });
      if (name === "member.benefit_catalog.get") return snapshot();
      if (name === "order.get") return structuredClone(orders.get(input.order_id));
      assert.fail(`unexpected query ${name}`);
    },
    expectCommandFailure: async (_session, name, input, code) => {
      calls.push({ method: "failure", name, input, code });
      assert.equal(code, "VALIDATION_FAILED");
      if (name === "member.points.earn") assert.equal(input.points, 999_999);
      else assert.equal(input.discount_cents, 500);
    },
    confirm: async (_session, name, input) => {
      calls.push({ method: "confirm", name, input });
      if (name === "member.benefit_definition.upsert") {
        return upsertDefinition(input.definition);
      }
      if (name === "member.membership.set") {
        benefits = { ...benefits, membership: { status: "active" } };
        return mutation();
      }
      if (name === "member.points.redeem") {
        benefits = { ...benefits, points: { available_points: 25 } };
        return mutation();
      }
      if (name === "member.asset.grant") {
        if (input.asset_kind === "punch") {
          benefits = {
            ...benefits,
            punch_cards: [
              { asset_id: PUNCH_ID, code: catalog.punch_types[0].code, remaining_uses: 3 },
            ],
          };
        } else {
          benefits = {
            ...benefits,
            coupons: [
              { asset_id: COUPON_ID, code: catalog.coupon_types[0].code, status: "active" },
            ],
          };
        }
        return mutation();
      }
      if (name === "order.cancel") {
        orders.set(input.order_id, {
          ...orders.get(input.order_id),
          status: "cancelled",
          paid_cents: 0,
          balance_cents: 0,
        });
        return { order_id: input.order_id, status: "cancelled" };
      }
      assert.fail(`unexpected confirm ${name}`);
    },
    command: async (_session, name, input) => {
      calls.push({ method: "command", name, input });
      if (name === "member.account.open") {
        return { account_id: ACCOUNT_ID, created: true, status: "active" };
      }
      if (name === "member.points.earn") {
        benefits = { ...benefits, points: { available_points: 26 } };
        return mutation();
      }
      if (name === "member.asset.consume" && input.asset.asset_kind === "punch") {
        benefits = {
          ...benefits,
          punch_cards: [{ ...benefits.punch_cards[0], remaining_uses: 2 }],
        };
        return mutation();
      }
      if (name === "order.receive") {
        orders.set(BENEFIT_ORDER_ID, {
          order_id: BENEFIT_ORDER_ID,
          status: "open",
          original_cents: 2_600,
          discount_cents: 0,
          payable_cents: 2_600,
          paid_cents: 0,
          balance_cents: 2_600,
        });
        return { order_id: BENEFIT_ORDER_ID };
      }
      if (name === "member.asset.consume" && input.asset.asset_kind === "coupon") {
        benefits = {
          ...benefits,
          coupons: [{ ...benefits.coupons[0], status: "redeemed" }],
        };
        orders.set(BENEFIT_ORDER_ID, {
          ...orders.get(BENEFIT_ORDER_ID),
          discount_cents: 500,
          payable_cents: 2_100,
          balance_cents: 2_100,
        });
        return mutation();
      }
      assert.fail(`unexpected command ${name}`);
    },
  });
  return { api, calls, read: () => ({ catalog, benefits, orders }) };
}

test("ADR-41 cloud journey derives points and coupon amounts server-side and restores definitions", async () => {
  const fake = fakeJourneyApi();
  let artifacts = {
    customerId: CUSTOMER_ID,
    customerPhone: "13800000123",
    cashOrderId: CASH_ORDER_ID,
    serviceCode: "wash",
    categoryCode: "coat",
  };
  const controller = createMemberBenefitsJourney({
    api: fake.api,
    adminSession: { staffId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    artifacts,
    run: { catalogCode: "uat_20260812_deadbeef", note: "ADR41 test", label: "ADR41" },
    update: (patch) => {
      artifacts = { ...artifacts, ...patch };
    },
  });
  await controller.execute();
  assert.equal(await controller.cleanup(), true);
  assert.equal(artifacts.memberAccountId, ACCOUNT_ID);
  assert.equal(artifacts.benefitOrderId, BENEFIT_ORDER_ID);
  const earnCalls = fake.calls.filter(
    (call) => call.method === "command" && call.name === "member.points.earn",
  );
  assert.equal(earnCalls.length, 2);
  assert.deepEqual(earnCalls[0].input, { account_id: ACCOUNT_ID, order_id: CASH_ORDER_ID });
  const couponCall = fake.calls.find(
    (call) =>
      call.method === "command" &&
      call.name === "member.asset.consume" &&
      call.input.asset.asset_kind === "coupon",
  );
  assert.deepEqual(couponCall.input, {
    asset: { asset_kind: "coupon", asset_id: COUPON_ID, order_id: BENEFIT_ORDER_ID },
  });
  assert.equal(fake.read().orders.get(BENEFIT_ORDER_ID).status, "cancelled");
  assert.equal(fake.read().catalog.points_policy.status, "retired");
  assert.ok(fake.read().catalog.tiers.every((row) => row.status === "retired"));
  assert.ok(fake.read().catalog.punch_types.every((row) => row.status === "retired"));
  assert.ok(fake.read().catalog.coupon_types.every((row) => row.status === "retired"));
});
