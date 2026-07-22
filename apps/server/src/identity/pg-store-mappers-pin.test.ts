/**
 * mapPin step-up binding (args_hash / entity_versions / idempotency_key).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mapPin, type PinRow } from "./pg-store-mappers.js";

const baseRow = (): PinRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222",
  store_id: "33333333-3333-4333-8333-333333333333",
  device_id: "44444444-4444-4444-8444-444444444444",
  session_id: "55555555-5555-4555-8555-555555555555",
  session_version: 1,
  purpose: "step_up",
  target_staff_id: null,
  approver_staff_id: "66666666-6666-4666-8666-666666666666",
  pending_action_ref: "77777777-7777-4777-8777-777777777777",
  args_hash: "a".repeat(64),
  entity_versions: [
    {
      entity_type: "settings",
      entity_id: "88888888-8888-4888-8888-888888888888",
      version: 3,
    },
  ],
  idempotency_key: "99999999-9999-4999-8999-999999999999",
  nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  attempts: 0,
  max_attempts: 5,
  status: "open",
  issued_at: new Date("2026-07-22T00:00:00Z"),
  expires_at: new Date("2026-07-22T00:02:00Z"),
  requester_staff_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
});

test("mapPin step_up preserves WYSIWYS binding fields", () => {
  const mapped = mapPin(baseRow());
  assert.ok(mapped);
  assert.equal(mapped.purpose, "step_up");
  assert.equal(mapped.args_hash, "a".repeat(64));
  assert.equal(mapped.pending_action_ref, "77777777-7777-4777-8777-777777777777");
  assert.equal(mapped.idempotency_key, "99999999-9999-4999-8999-999999999999");
  assert.equal(mapped.approver_staff_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(mapped.entity_versions?.length, 1);
  assert.equal(mapped.entity_versions?.[0]?.entity_type, "settings");
  assert.equal(mapped.entity_versions?.[0]?.version, 3);
});

test("mapPin step_up rejects missing args_hash", () => {
  const mapped = mapPin({ ...baseRow(), args_hash: null });
  assert.equal(mapped, null);
});

test("mapPin quick_switch ignores step-up columns", () => {
  const mapped = mapPin({
    ...baseRow(),
    purpose: "quick_switch",
    target_staff_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    approver_staff_id: null,
    pending_action_ref: null,
    args_hash: null,
    entity_versions: [],
    idempotency_key: null,
  });
  assert.ok(mapped);
  assert.equal(mapped.purpose, "quick_switch");
  assert.equal(mapped.target_staff_id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(mapped.args_hash, undefined);
});
