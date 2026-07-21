import assert from "node:assert/strict";
import test from "node:test";
import { COUNTER_NAV } from "../nav.js";
import {
  FULL_STORE_FEATURES,
  STAFF_STORE_FEATURES,
  allowedNavKeys,
  filterNavItems,
  hasFeature,
  isNavAllowed,
  isRuleSatisfied,
  permissionContextFrom,
} from "./permissions.js";

const adminCtx = permissionContextFrom("admin", FULL_STORE_FEATURES);
const staffCtx = permissionContextFrom("staff", STAFF_STORE_FEATURES);

test("admin sees all counter nav keys", () => {
  const keys = allowedNavKeys(adminCtx);
  assert.deepEqual(
    [...keys],
    COUNTER_NAV.map((n) => n.id),
  );
  for (const item of COUNTER_NAV) {
    assert.equal(isNavAllowed(adminCtx, item.id), true, item.id);
  }
});

test("staff hides restricted routes (stats, settings)", () => {
  const keys = allowedNavKeys(staffCtx);
  assert.ok(keys.includes("workbench"));
  assert.ok(keys.includes("receive"));
  assert.ok(keys.includes("pickup"));
  assert.ok(keys.includes("customers"));
  assert.equal(keys.includes("stats"), false);
  assert.equal(keys.includes("settings"), false);
  assert.equal(isNavAllowed(staffCtx, "stats"), false);
  assert.equal(isNavAllowed(staffCtx, "settings"), false);
});

test("filterNavItems drops denied sidebar entries for staff", () => {
  const items = filterNavItems(staffCtx);
  const ids = items.map((i) => i.id);
  assert.equal(ids.includes("settings"), false);
  assert.equal(ids.includes("stats"), false);
  assert.ok(ids.includes("receive"));
});

test("feature rules deny when flag is false (engine)", () => {
  const ctx = permissionContextFrom("admin", {
    ...FULL_STORE_FEATURES,
    ai_enabled: false,
  });
  assert.equal(hasFeature(ctx.features, "ai_enabled"), false);
  assert.equal(isRuleSatisfied(ctx, { features: ["ai_enabled"] }), false);
  assert.equal(isRuleSatisfied(ctx, { features: ["member_enabled"] }), true);
});

test("role rule fails closed for unknown role projection", () => {
  // staff cannot pass admin-only rule even with full features
  const fullStaff = permissionContextFrom("staff", FULL_STORE_FEATURES);
  assert.equal(isNavAllowed(fullStaff, "settings"), false);
  assert.equal(isRuleSatisfied(fullStaff, { roles: ["admin"] }), false);
});
