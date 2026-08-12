import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorizedSession } from "../auth/session-view.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import {
  isConfiguredRuntimeTenant,
  isRuntimeBusOperationAvailable,
} from "./runtime-surface-policy.js";

function session(orgId: string, storeId: string): AuthorizedSession {
  return {
    session: {
      session_id: "11111111-1111-4111-8111-111111111111",
      family_id: "22222222-2222-4222-8222-222222222222",
      org_id: orgId,
      store_id: storeId,
      staff_id: "33333333-3333-4333-8333-333333333333",
      device_id: "44444444-4444-4444-8444-444444444444",
      permission_version: 1,
      session_version: 1,
      authentication_method: "password",
      status: "active",
      created_at: 1,
      revoked_at: null,
    },
    authority: {
      staff_id: "33333333-3333-4333-8333-333333333333",
      display_name: "Owner",
      role: "admin",
      permission_version: 1,
      is_privacy_admin: true,
    },
  };
}

test("configured store retains the complete runtime bus", () => {
  const resolved = session(LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId);
  assert.equal(isConfiguredRuntimeTenant(resolved), true);
  assert.equal(isRuntimeBusOperationAvailable(resolved, "command", "order.receive"), true);
  assert.equal(isRuntimeBusOperationAvailable(resolved, "query", "catalog.items.get"), true);
});

test("another store is restricted to the Stage 3.2 Owner bus surface", () => {
  const resolved = session(
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  );
  assert.equal(isConfiguredRuntimeTenant(resolved), false);

  for (const name of [
    "accounting.report.export",
    "staff.access.set",
    "staff.create",
    "staff.credentials.reset",
    "store.profile.set",
  ]) {
    assert.equal(isRuntimeBusOperationAvailable(resolved, "command", name), true, name);
  }
  for (const name of [
    "accounting.report.get",
    "reporting.owner_dashboard.get",
    "reporting.owner_dashboard.drilldown",
    "reporting.owner_portfolio.get",
    "staff.access.list",
    "store.authorized.list",
  ]) {
    assert.equal(isRuntimeBusOperationAvailable(resolved, "query", name), true, name);
  }

  assert.equal(isRuntimeBusOperationAvailable(resolved, "command", "order.receive"), false);
  assert.equal(isRuntimeBusOperationAvailable(resolved, "query", "catalog.items.get"), false);
  for (const name of [
    "fulfillment.batch.create",
    "fulfillment.batch.cancel",
    "fulfillment.handoff.checkpoint.record",
    "fulfillment.handoff.discrepancy.resolve",
    "fulfillment.quality_check.record",
  ]) {
    assert.equal(isRuntimeBusOperationAvailable(resolved, "command", name), false, name);
  }
  for (const name of ["fulfillment.batches.list", "fulfillment.batch.get"]) {
    assert.equal(isRuntimeBusOperationAvailable(resolved, "query", name), false, name);
  }
});
