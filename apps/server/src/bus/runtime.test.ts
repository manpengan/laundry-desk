import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { createRuntimeBus, permissionsForAuthority } from "./runtime.js";

test("runtime roles carry the customer permissions required by member operations", () => {
  for (const role of ["admin", "staff"] as const) {
    const permissions = permissionsForAuthority({ role, is_privacy_admin: false });
    assert.ok(permissions.includes("customer_read"), role);
    assert.ok(permissions.includes("customer_write"), role);
  }
});

test("only administrators can apply a manual order discount", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  assert.equal(admin.includes("order_discount"), true);
  assert.equal(staff.includes("order_discount"), false);
});

test("runtime roles separate protective freeze from lifecycle administration", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  for (const permissions of [admin, staff]) assert.ok(permissions.includes("member_freeze"));
  assert.ok(admin.includes("member_lifecycle_manage"));
  assert.ok(admin.includes("member_refund"));
  assert.equal(staff.includes("member_lifecycle_manage"), false);
  assert.equal(staff.includes("member_refund"), false);
});

test("owner dashboard accounting authority remains admin-only", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  assert.ok(admin.includes("accounting_read"));
  assert.equal(staff.includes("accounting_read"), false);
});

test("runtime bus registers the complete member command and query surface", async () => {
  const runtime = await createMemoryLocalRuntime();
  const bus = createRuntimeBus(runtime);

  assert.ok(bus.registered.includes("member.account.open"));
  assert.ok(bus.registered.includes("member.topup"));
  assert.ok(bus.registered.includes("member.balance.pay"));
  assert.ok(bus.registered.includes("member.account.freeze"));
  assert.ok(bus.registered.includes("member.account.unfreeze"));
  assert.ok(bus.registered.includes("member.account.close"));
  assert.ok(bus.registeredQueries.includes("member.account.get"));
  assert.ok(bus.registered.includes("notification.manual_list.create"));
  assert.ok(bus.registeredQueries.includes("notification.pickup_reminders.list"));
  assert.ok(bus.registeredQueries.includes("reporting.owner_dashboard.get"));
});
