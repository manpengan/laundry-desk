import assert from "node:assert/strict";
import test from "node:test";

import { INSERT_AUDIT_LOG_SQL } from "../audit/write-audit.js";
import type { PgPoolClient } from "../db/pg-pool.js";
import { writePinLockoutAudit } from "./pin-lockout-audit.js";

test("PIN lockout audit is stable and contains no credential material", async () => {
  const orgId = "00000000-1234-4000-8000-000000000000";
  const writes: Readonly<{ sql: string; values: readonly unknown[] }>[] = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      writes.push(Object.freeze({ sql, values: Object.freeze([...values]) }));
      return Object.freeze({ rows: [], rowCount: 1 });
    },
  } as unknown as PgPoolClient;

  await writePinLockoutAudit(client, {
    org_id: orgId,
    store_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actor_staff_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    target_staff_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    attempted_at: 1_700_000_000,
  });

  assert.equal(writes.length, 1);
  const write = writes[0];
  assert.ok(write);
  assert.equal(write.sql, INSERT_AUDIT_LOG_SQL);
  const [auditId, ...auditedValues] = write.values;
  assert.ok(typeof auditId === "string");
  assert.match(auditId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  // Valid UUIDs can contain PIN-like digits; require the exact allowed audit fields.
  assert.deepEqual(auditedValues, [
    orgId,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "ui",
    "identity.pin.locked",
    null,
    false,
    "staff",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    null,
    '{"lockout":"active","reason":"failed_pin_threshold"}',
    null,
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "2023-11-14T22:13:20.000Z",
  ]);
});
