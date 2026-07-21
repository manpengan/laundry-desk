import assert from "node:assert/strict";
import test from "node:test";

import {
  RLS_BYPASS_CLASSES,
  RlsBypassError,
  isRlsBypassClass,
  requestRlsBypass,
  type BypassAuditEvent,
} from "./bypass.js";

test("RLS_BYPASS_CLASSES is a closed default-deny allowlist of five classes", () => {
  assert.equal(RLS_BYPASS_CLASSES.length, 5);
  assert.deepEqual(
    [...RLS_BYPASS_CLASSES],
    [
      "migration_owner",
      "maintenance",
      "platform_global_read",
      "platform_global_write",
      "support_break_glass",
    ],
  );
  assert.equal(isRlsBypassClass("migration_owner"), true);
  assert.equal(isRlsBypassClass("laundry_app"), false);
  assert.equal(isRlsBypassClass("BYPASSRLS"), false);
});

test("bypass without reason is rejected", async () => {
  await assert.rejects(
    () => requestRlsBypass({ bypassClass: "maintenance", reason: "" }),
    RlsBypassError,
  );
  await assert.rejects(
    () => requestRlsBypass({ bypassClass: "maintenance", reason: "   " }),
    /reason is required/,
  );
});

test("unknown bypass class is default-denied", async () => {
  await assert.rejects(
    () =>
      requestRlsBypass({
        bypassClass: "pool_cross_tenant",
        reason: "should never work",
      }),
    /not allowed \(default deny\)/,
  );
});

test("allowed bypass grants and emits audit stub event", async () => {
  const events: BypassAuditEvent[] = [];
  const grant = await requestRlsBypass(
    {
      bypassClass: "migration_owner",
      reason: "apply contracts A3 RLS templates",
    },
    (event) => {
      events.push(event);
    },
  );

  assert.equal(grant.bypassClass, "migration_owner");
  assert.equal(grant.reason, "apply contracts A3 RLS templates");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "rls_bypass_granted");
  assert.equal(events[0]?.bypassClass, "migration_owner");
  assert.ok(events[0]?.at);
});
