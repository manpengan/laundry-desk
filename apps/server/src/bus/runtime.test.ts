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

test("authorized store management remains admin-only", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  assert.ok(admin.includes("store_manage"));
  assert.equal(staff.includes("store_manage"), false);
});

test("automatic notification delivery remains admin-only", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  assert.equal(admin.includes("notification_send"), true);
  assert.equal(staff.includes("notification_send"), false);
});

test("factory handoff and QC are internal staff capabilities while reconciliation is admin-only", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  for (const permissions of [admin, staff]) {
    assert.equal(permissions.includes("fulfillment_handoff"), true);
    assert.equal(permissions.includes("fulfillment_qc"), true);
  }
  assert.equal(admin.includes("fulfillment_reconcile"), true);
  assert.equal(staff.includes("fulfillment_reconcile"), false);
});

test("delivery policy quotes are readable by staff while configuration remains admin-only", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  assert.equal(admin.includes("delivery_read"), true);
  assert.equal(staff.includes("delivery_read"), true);
  assert.equal(admin.includes("settings_admin"), true);
  assert.equal(staff.includes("settings_admin"), false);
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
  assert.ok(bus.registered.includes("notification.delivery_batch.enqueue"));
  assert.ok(bus.registeredQueries.includes("notification.pickup_reminders.list"));
  assert.ok(bus.registeredQueries.includes("notification.delivery.capability.get"));
  assert.ok(bus.registeredQueries.includes("notification.delivery_batches.list"));
  assert.ok(bus.registeredQueries.includes("notification.delivery_batch.get"));
  for (const name of [
    "fulfillment.batch.create",
    "fulfillment.batch.cancel",
    "fulfillment.handoff.checkpoint.record",
    "fulfillment.handoff.discrepancy.resolve",
    "fulfillment.quality_check.record",
  ]) {
    assert.ok(bus.registered.includes(name), name);
  }
  for (const name of ["fulfillment.batches.list", "fulfillment.batch.get"]) {
    assert.ok(bus.registeredQueries.includes(name), name);
  }
  assert.ok(bus.registeredQueries.includes("reporting.owner_dashboard.get"));
  assert.ok(bus.registered.includes("store.profile.set"));
  assert.ok(bus.registeredQueries.includes("store.authorized.list"));
  assert.ok(bus.registered.includes("delivery.policy.set"));
  assert.ok(bus.registeredQueries.includes("delivery.policy.get"));
  assert.ok(bus.registeredQueries.includes("delivery.availability.quote"));
  for (const name of [
    "member.benefit_definition.upsert",
    "member.membership.set",
    "member.points.earn",
    "member.points.redeem",
    "member.asset.grant",
    "member.asset.consume",
  ]) {
    assert.ok(bus.registered.includes(name), name);
  }
  for (const name of ["member.benefit_catalog.get", "member.benefits.get"]) {
    assert.ok(bus.registeredQueries.includes(name), name);
  }
});
