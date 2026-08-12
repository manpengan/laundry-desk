import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomerDiscountBody,
  buildCustomerProfileBody,
  discountModeFor,
  formatDiscountPercent,
  parseCustomerProfile,
  profileDraftFromView,
} from "./customer-profile-model.js";

const PROFILE = Object.freeze({
  customer_id: "10000000-0000-4000-8000-000000000001",
  version: 2,
  gender: "female" as const,
  preferred_contact: "wechat" as const,
  service_note: "低温护理",
  waivers: Object.freeze({
    skip_ticket_print: true,
    skip_label_print: false,
    skip_rack_assignment: true,
  }),
  discount_bps: 875,
  addresses: Object.freeze([
    Object.freeze({
      address_id: "20000000-0000-4000-8000-000000000001",
      label: "公司",
      recipient: "王女士",
      contact_phone: null,
      address: "测试路 1 号",
      is_default: true,
    }),
  ]),
  identifiers: Object.freeze([
    Object.freeze({
      identifier_id: "30000000-0000-4000-8000-000000000001",
      kind: "vehicle_plate" as const,
      value: "沪A-12345",
    }),
  ]),
  updated_at: 1_775_174_700,
});

test("customer profile parser validates and freezes the bus result", () => {
  const parsed = parseCustomerProfile({ execution: "executed", result: PROFILE });
  assert.deepEqual(parsed, PROFILE);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed?.addresses), true);
  assert.equal(parseCustomerProfile({ ...PROFILE, extra: true }), null);
});

test("profile draft builds a strict trimmed CAS command without UI keys", () => {
  const parsed = parseCustomerProfile(PROFILE);
  assert.ok(parsed);
  const draft = profileDraftFromView(parsed);
  const built = buildCustomerProfileBody(PROFILE.customer_id, PROFILE.version, {
    ...draft,
    service_note: "  低温护理  ",
    reason: "  顾客确认偏好  ",
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.body.service_note, "低温护理");
  assert.equal(built.body.reason, "顾客确认偏好");
  assert.deepEqual(built.body.addresses, [
    {
      label: "公司",
      recipient: "王女士",
      contact_phone: null,
      address: "测试路 1 号",
      is_default: true,
    },
  ]);
  assert.equal(JSON.stringify(built.body).includes("address_id"), false);
  assert.equal(JSON.stringify(built.body).includes('"key"'), false);
});

test("profile builder rejects duplicate defaults and normalized identifiers", () => {
  const parsed = parseCustomerProfile(PROFILE);
  assert.ok(parsed);
  const draft = profileDraftFromView(parsed);
  const invalid = buildCustomerProfileBody(PROFILE.customer_id, PROFILE.version, {
    ...draft,
    reason: "test",
    addresses: Object.freeze([
      ...draft.addresses,
      Object.freeze({
        key: "other",
        label: "家",
        recipient: "",
        contact_phone: "",
        address: "测试路 2 号",
        is_default: true,
      }),
    ]),
    identifiers: Object.freeze([
      ...draft.identifiers,
      Object.freeze({ key: "duplicate", kind: "vehicle_plate", value: "沪 A 12345" }),
    ]),
  });
  assert.equal(invalid.ok, false);
});

test("discount builder preserves inherit, explicit zero and precise positive bps", () => {
  assert.equal(discountModeFor(null), "inherit");
  assert.equal(discountModeFor(0), "disabled");
  assert.equal(discountModeFor(875), "customer");
  assert.equal(formatDiscountPercent(875), "8.75");
  const inherit = buildCustomerDiscountBody(PROFILE.customer_id, 2, "inherit", "", "继承等级");
  const disabled = buildCustomerDiscountBody(PROFILE.customer_id, 2, "disabled", "", "不打折");
  const customer = buildCustomerDiscountBody(PROFILE.customer_id, 2, "customer", "8.75", "专属");
  assert.equal(inherit.ok && inherit.body.discount_bps, null);
  assert.equal(disabled.ok && disabled.body.discount_bps, 0);
  assert.equal(customer.ok && customer.body.discount_bps, 875);
  assert.equal(
    buildCustomerDiscountBody(PROFILE.customer_id, 2, "customer", "0", "invalid").ok,
    false,
  );
});
