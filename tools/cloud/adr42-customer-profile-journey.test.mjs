import assert from "node:assert/strict";
import test from "node:test";

import { createCustomerProfileJourney } from "./adr42-customer-profile-journey.mjs";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const COUPON_ID = "44444444-4444-4444-8444-444444444444";
const TIER_ORDER_ID = "55555555-5555-4555-8555-555555555555";
const CUSTOMER_ORDER_ID = "66666666-6666-4666-8666-666666666666";
const TIER_GARMENT_ID = "77777777-7777-4777-8777-777777777777";
const CUSTOMER_GARMENT_ID = "88888888-8888-4888-8888-888888888888";
const ADMIN = Object.freeze({
  staffId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
});
const APPROVER = Object.freeze({ staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });

function emptyProfile() {
  return Object.freeze({
    customer_id: CUSTOMER_ID,
    version: 0,
    gender: "unspecified",
    preferred_contact: "none",
    service_note: null,
    waivers: Object.freeze({
      skip_ticket_print: false,
      skip_label_print: false,
      skip_rack_assignment: false,
    }),
    discount_bps: null,
    addresses: Object.freeze([]),
    identifiers: Object.freeze([]),
    updated_at: null,
  });
}

function fakeJourneyApi() {
  let profile = emptyProfile();
  let tier = Object.freeze({
    definition_id: TIER_ID,
    code: "adr41_tier",
    name: "ADR41 UAT 等级",
    level: 9,
    discount_bps: 0,
    status: "active",
    version: 1,
    note: "ADR41 test",
  });
  let membership = Object.freeze({
    version: 1,
    tier: Object.freeze({
      definition_id: TIER_ID,
      code: tier.code,
      name: tier.name,
      level: tier.level,
      discount_bps: tier.discount_bps,
    }),
    valid_until: "2099-12-31",
    status: "active",
  });
  const coupon = Object.freeze({ asset_id: COUPON_ID, status: "active" });
  let orders = Object.freeze({});
  let calls = Object.freeze([]);
  const record = (call) => {
    calls = Object.freeze([...calls, Object.freeze(call)]);
  };
  const benefits = () =>
    Object.freeze({
      account_id: ACCOUNT_ID,
      customer_id: CUSTOMER_ID,
      account_status: "active",
      membership,
      coupons: Object.freeze([coupon]),
    });
  const catalog = () =>
    Object.freeze({
      tiers: Object.freeze([tier]),
      points_policy: null,
      punch_types: Object.freeze([]),
      coupon_types: Object.freeze([]),
    });

  const query = async (_session, name, input) => {
    record({ method: "query", name, input });
    if (name === "customer.profile.get") return structuredClone(profile);
    if (name === "customer.search") {
      return {
        customers:
          input.query === "uat 812_deadbeef"
            ? [
                {
                  customer_id: CUSTOMER_ID,
                  phone_masked: "138****0123",
                  name: "ADR42 UAT",
                  version: 1,
                  updated_at: 1_700_000_000,
                },
              ]
            : [],
      };
    }
    if (name === "member.benefits.get") return structuredClone(benefits());
    if (name === "member.benefit_catalog.get") return structuredClone(catalog());
    if (name === "order.get") return structuredClone(orders[input.order_id]);
    assert.fail(`unexpected query ${name}`);
  };

  const setProfile = (input) => {
    assert.equal(input.expected_version, profile.version);
    const nextVersion = profile.version + 1;
    profile = Object.freeze({
      ...profile,
      ...input,
      version: nextVersion,
      addresses: Object.freeze(
        input.addresses.map((address, index) =>
          Object.freeze({
            address_id: `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`,
            ...address,
          }),
        ),
      ),
      identifiers: Object.freeze(
        input.identifiers.map((identifier, index) =>
          Object.freeze({
            identifier_id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
            ...identifier,
          }),
        ),
      ),
      updated_at: 1_700_000_000 + nextVersion,
    });
    return {
      customer_id: CUSTOMER_ID,
      version: nextVersion,
      address_count: profile.addresses.length,
      identifier_count: profile.identifiers.length,
    };
  };

  const confirm = async (_session, name, input) => {
    record({ method: "confirm", name, input });
    if (name === "customer.profile.set") return setProfile(input);
    if (name === "member.benefit_definition.upsert") {
      const definition = input.definition;
      assert.equal(definition.expected_version, tier.version);
      tier = Object.freeze({
        ...tier,
        ...definition,
        version: tier.version + 1,
        note: definition.note ?? null,
      });
      return { catalog: structuredClone(catalog()) };
    }
    if (name === "member.membership.set") {
      assert.equal(input.expected_version, membership.version);
      membership = Object.freeze({
        version: membership.version + 1,
        tier: Object.freeze({
          definition_id: TIER_ID,
          code: tier.code,
          name: tier.name,
          level: tier.level,
          discount_bps: tier.discount_bps,
        }),
        valid_until: input.valid_until,
        status: "active",
      });
      return { benefits: structuredClone(benefits()) };
    }
    if (name === "order.cancel") {
      const current = orders[input.order_id];
      assert.ok(current);
      orders = Object.freeze({
        ...orders,
        [input.order_id]: Object.freeze({
          ...current,
          status: "cancelled",
          paid_cents: 0,
          balance_cents: 0,
        }),
      });
      return { order_id: input.order_id, status: "cancelled" };
    }
    assert.fail(`unexpected confirm ${name}`);
  };

  const stepUp = async (_session, name, input, approverId, pin) => {
    record({ method: "stepUp", name, input, approverId });
    assert.equal(name, "customer.discount_policy.set");
    assert.equal(approverId, APPROVER.staffId);
    assert.equal(pin, "654321");
    assert.equal(input.expected_version, profile.version);
    profile = Object.freeze({
      ...profile,
      version: profile.version + 1,
      discount_bps: input.discount_bps,
    });
    return {
      customer_id: CUSTOMER_ID,
      version: profile.version,
      address_count: profile.addresses.length,
      identifier_count: profile.identifiers.length,
    };
  };

  const command = async (_session, name, input) => {
    record({ method: "command", name, input });
    assert.equal(name, "order.receive");
    const first = Object.keys(orders).length === 0;
    const orderId = first ? TIER_ORDER_ID : CUSTOMER_ORDER_ID;
    const garmentId = first ? TIER_GARMENT_ID : CUSTOMER_GARMENT_ID;
    const discountBps = profile.discount_bps ?? membership.tier.discount_bps;
    const discountCents = Math.floor((2_600 * discountBps) / 10_000);
    const order = Object.freeze({
      order_id: orderId,
      status: "open",
      original_cents: 2_600,
      discount_cents: discountCents,
      payable_cents: 2_600 - discountCents,
      paid_cents: 0,
      balance_cents: 2_600 - discountCents,
      discount_source: profile.discount_bps === null ? "tier" : "customer",
      discount_bps: discountBps,
      customer_profile_version: profile.version,
      waivers: profile.waivers,
      garments: Object.freeze([
        Object.freeze({ garment_id: garmentId, barcode: first ? "ADR42TIER" : "ADR42CUSTOMER" }),
      ]),
    });
    orders = Object.freeze({ ...orders, [orderId]: order });
    return structuredClone(order);
  };

  const expectCommandFailure = async (_session, name, input, code) => {
    record({ method: "failure", name, input, code });
    if (name === "customer.profile.set") {
      assert.equal(input.org_id, ADMIN.orgId);
      assert.equal(code, "VALIDATION_FAILED");
      return;
    }
    if (name === "order.receive") {
      assert.equal(input.discount_bps, 1);
      assert.equal(code, "VALIDATION_FAILED");
      return;
    }
    if (name === "print.ticket.enqueue" || name === "garment.rack.assign") {
      assert.equal(code, "INVARIANT_FAILED");
      return;
    }
    if (name === "member.asset.consume") {
      assert.equal(input.asset.asset_id, COUPON_ID);
      assert.ok(orders[input.asset.order_id].discount_cents > 0);
      assert.equal(code, "INVARIANT_FAILED");
      return;
    }
    assert.fail(`unexpected failure ${name}`);
  };

  return Object.freeze({
    api: Object.freeze({ query, confirm, stepUp, command, expectCommandFailure }),
    read: () => Object.freeze({ profile, membership, tier, orders, calls }),
  });
}

test("ADR-42 cloud journey proves profile search, tier/customer pricing, waivers and cleanup", async () => {
  const fake = fakeJourneyApi();
  let artifacts = Object.freeze({
    customerId: CUSTOMER_ID,
    customerPhone: "13800000123",
    memberAccountId: ACCOUNT_ID,
    cleanupUncertain: false,
  });
  const controller = createCustomerProfileJourney({
    api: fake.api,
    adminSession: ADMIN,
    approverSession: APPROVER,
    approverPin: "654321",
    artifacts,
    run: {
      catalogCode: "uat_20260812_deadbeef",
      note: "ADR42 synthetic test",
      label: "ADR42 UAT",
      serviceCode: "wash",
      categoryCode: "coat",
    },
    update: (patch) => {
      artifacts = Object.freeze({ ...artifacts, ...patch });
    },
  });

  await controller.execute();
  assert.equal(await controller.cleanup(), true);
  const state = fake.read();
  assert.equal(state.profile.version, 4);
  assert.equal(state.profile.discount_bps, null);
  assert.equal(state.profile.service_note, null);
  assert.deepEqual(state.profile.addresses, []);
  assert.deepEqual(state.profile.identifiers, []);
  assert.deepEqual(state.profile.waivers, {
    skip_ticket_print: false,
    skip_label_print: false,
    skip_rack_assignment: false,
  });
  assert.equal(state.membership.version, 2);
  assert.equal(state.membership.tier.discount_bps, 800);
  assert.equal(state.orders[TIER_ORDER_ID].discount_cents, 208);
  assert.equal(state.orders[CUSTOMER_ORDER_ID].discount_cents, 325);
  assert.equal(state.orders[TIER_ORDER_ID].status, "cancelled");
  assert.equal(state.orders[CUSTOMER_ORDER_ID].status, "cancelled");
  assert.equal(artifacts.cleanupUncertain, false);
  assert.equal(state.calls.filter((call) => call.method === "stepUp").length, 2);
  assert.equal(state.calls.filter((call) => call.name === "print.ticket.enqueue").length, 4);
});
