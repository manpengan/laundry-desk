import assert from "node:assert/strict";
import test from "node:test";

import type { PgPoolClient } from "../db/pg-pool.js";
import { writePinLockoutAudit } from "./pin-lockout-audit.js";

test("PIN lockout audit is stable and contains no credential material", async () => {
  const writes: Readonly<{ sql: string; values: readonly unknown[] }>[] = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      writes.push(Object.freeze({ sql, values: Object.freeze([...values]) }));
      return Object.freeze({ rows: [], rowCount: 1 });
    },
  } as unknown as PgPoolClient;

  await writePinLockoutAudit(client, {
    org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    store_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actor_staff_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    target_staff_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    attempted_at: 1_700_000_000,
  });

  assert.equal(writes.length, 1);
  const write = writes[0];
  assert.ok(write);
  assert.match(write.sql, /^INSERT INTO audit_log/u);
  assert.equal(write.values[3], "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(write.values[5], "identity.pin.locked");
  assert.equal(write.values[8], "staff");
  assert.equal(write.values[9], "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  assert.equal(write.values[11], '{"lockout":"active","reason":"failed_pin_threshold"}');
  const serialized = JSON.stringify(write.values);
  assert.doesNotMatch(serialized, /cookie|token|password|1234|0000/iu);
});
