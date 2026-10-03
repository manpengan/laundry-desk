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
    ["ai_provider_keys", "notification_provider_settings", "payment_channel_settings"],
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
    provider_ref_sha256: "a".repeat(64),
    reserved_cost_cents: "10",
    cost_cents: "8",
    accepted_at: "2026-10-03",
  };
  const result = reset("notification_deliveries", row);
  assert.equal(result.status, "manual_required");
  assert.equal(result.lease_token, null);
  assert.equal(result.provider_outcome_pending, "false");
  assert.equal(result.last_error_code, "RESTORE_REQUIRES_RECONCILIATION");
  for (const key of ["provider_ref_sha256", "reserved_cost_cents", "cost_cents", "accepted_at"])
    assert.equal(result[key], row[key]);
  assert.equal(row.status, "sending");
});

test("restored live AI credentials become terminal and cannot be reactivated by config", () => {
  const result = reset("ai_provider_keys", {
    status: "active",
    row_version: "2",
    revoked_at: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  });
  assert.equal(result.status, "revoked");
  assert.equal(result.row_version, "3");
  assert.ok(result.revoked_at);
  const terminal = { status: "superseded", row_version: "4", superseded_at: "2026-01-02" };
  assert.deepEqual(reset("ai_provider_keys", terminal), terminal);
});

test("restored payment uncertainty requires queries and remote assistance never resumes", () => {
  const pending = {
    state: "unknown",
    checkout_json: '{"code":"expired"}',
    error_code: null,
    dispatched_at: "2026-10-03",
    amount_cents: "1250",
    merchant_order: "retained",
  };
  assert.deepEqual(reset("payment_channel_intents", pending), {
    ...pending,
    state: "needs_review",
    checkout_json: null,
    error_code: "MIGRATED_QUERY_REQUIRED",
  });
  const paid = { state: "paid", provider_order: "settled" };
  assert.deepEqual(reset("payment_channel_intents", paid), paid);
  assert.equal(
    reset("payment_channel_refunds", { state: "pending", error_code: null }).state,
    "needs_review",
  );
  const refunded = { state: "refunded", provider_refund: "settled" };
  assert.deepEqual(reset("payment_channel_refunds", refunded), refunded);
  assert.equal(
    reset("remote_assistance_sessions", { status: "active", revoked_at: null }).status,
    "revoked",
  );
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
