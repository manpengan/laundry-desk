import assert from "node:assert/strict";
import { test } from "node:test";
import {
  portableLoadOrder,
  requirePortableInventory,
  requirePortableRow,
  requirePortableSchema,
  schemaFingerprint,
} from "./portable-schema.mjs";
import { OMIT_PORTABLE_TABLE_DATA, resetPortableAuthority } from "./portable-authority.mjs";
import { portableLines } from "./portable-database.mjs";

const table = (name, columns = ["id"], parents = []) => ({
  name,
  columns: columns.map((name) => ({ name, type: "text" })),
  parents,
  sequences: [],
});
const schema = [
  table("children", ["id"], ["parents"]),
  table("laundry_schema_migrations"),
  table("parents"),
];

test("schema binds identifiers, unique columns, table inventory and foreign key order", () => {
  assert.deepEqual(
    portableLoadOrder(schema).map((t) => t.name),
    ["laundry_schema_migrations", "parents", "children"],
  );
  assert.equal(schemaFingerprint(schema).length, 64);
  for (const invalid of [
    [...schema, schema[0]],
    [table("bad;DROP TABLE")],
    [table("laundry_schema_migrations", ["id", "id"])],
    schema.map((t) => (t.name === "parents" ? { ...t, parents: ["children"] } : t)),
  ]) {
    assert.throws(() => portableLoadOrder(invalid), /PORTABLE_SCHEMA/);
  }
  assert.throws(
    () => requirePortableSchema([{ ...schema[0], unexpected: true }]),
    /PORTABLE_SCHEMA/,
  );
  assert.throws(() => requirePortableRow([42], schema[0]), /PORTABLE_ROW/);
  assert.throws(() => requirePortableRow(["nul\0value"], schema[0]), /PORTABLE_ROW/);
  assert.deepEqual(requirePortableRow(["'); DROP TABLE orgs; --\n\\."], schema[0]), [
    "'); DROP TABLE orgs; --\n\\.",
  ]);
});

test("inventory rejects absent/extra counts and unsafe sequence values", () => {
  const inventory = {
    schema,
    counts: { children: 0, parents: 1, laundry_schema_migrations: 1 },
    sequences: {},
    size: 5,
    sha256: "a".repeat(64),
  };
  assert.equal(requirePortableInventory(inventory), inventory);
  assert.throws(
    () => requirePortableInventory({ ...inventory, counts: { ...inventory.counts, invented: 1 } }),
    /PORTABLE_INVENTORY/,
  );
  assert.throws(
    () => requirePortableInventory({ ...inventory, counts: { ...inventory.counts, parents: -1 } }),
    /PORTABLE_INVENTORY/,
  );
  assert.throws(
    () =>
      requirePortableInventory({
        ...inventory,
        sequences: { injected: { value: "1", called: true } },
      }),
    /PORTABLE_INVENTORY/,
  );
});

const reset = (name, row) =>
  Object.fromEntries(
    Object.keys(row).map((key, i) => [
      key,
      resetPortableAuthority(
        table(name, Object.keys(row)),
        Object.values(row),
        "2026-10-03T12:00:00Z",
      )[i],
    ]),
  );

test("cross-machine restore revokes authority and preserves terminal business history", () => {
  assert.deepEqual(
    [...OMIT_PORTABLE_TABLE_DATA],
    ["ai_provider_keys", "notification_provider_settings"],
  );
  const session = reset("sessions", {
    status: "active",
    revoked_at: null,
    session_version: "3",
    created_at: "2027-01-01T00:00:00Z",
  });
  assert.equal(session.status, "revoked");
  assert.equal(session.session_version, "4");
  assert.equal(session.revoked_at, "2027-01-01T00:00:00.000Z");
  assert.equal(reset("ai_safety_policies", { enabled: "true" }).enabled, "false");
  assert.deepEqual(reset("orders", { id: "unchanged", status: "completed" }), {
    id: "unchanged",
    status: "completed",
  });
  const pending = { status: "pending_approval", next_run_at: null, updated_at: "2026-01-01" };
  assert.deepEqual(reset("automation_policies", pending), pending);
  assert.throws(
    () => reset("sessions", { status: "active", session_version: "2147483647", revoked_at: null }),
    /PORTABLE_AUTHORITY/,
  );
  assert.throws(() => reset("edge_devices", { status: "paired" }), /PORTABLE_AUTHORITY_SCHEMA/);
});

test("unknown SMS outcomes require reconciliation and cannot automatically resend", () => {
  const row = {
    status: "sending",
    next_attempt_at: null,
    claimed_at: "2026-10-03",
    lease_until: "2026-10-04",
    lease_token: "lease",
    worker_id: "old",
    recipient_hmac: "hash",
    message_sha256: "hash",
    last_error_code: null,
    provider_outcome_pending: "true",
    updated_at: "2026-10-03",
  };
  const result = reset("notification_deliveries", row);
  assert.equal(result.status, "manual_required");
  assert.equal(result.lease_token, null);
  assert.equal(result.provider_outcome_pending, "false");
  assert.equal(result.last_error_code, "RESTORE_REQUIRES_RECONCILIATION");
  assert.equal(row.status, "sending");
});

function memoryInput(bytes) {
  return {
    read: async (out, offset, length, position) => ({
      bytesRead: bytes.copy(out, offset, position, position + length),
    }),
  };
}
test("NDJSON rejects invalid UTF-8, malformed JSON and missing final newline", async () => {
  const read = async (bytes) => {
    const values = [];
    for await (const value of portableLines(memoryInput(bytes))) values.push(value);
    return values;
  };
  assert.deepEqual(await read(Buffer.from('["one",null]\nnull\n')), [["one", null], null]);
  for (const bytes of [Buffer.from('["truncated"]'), Buffer.from("bad\n"), Buffer.from([0xff, 10])])
    await assert.rejects(read(bytes), /PORTABLE_/);
});
