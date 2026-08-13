import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { createPgDeliveryAppointmentStore } from "./pg-store.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADDRESS_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const AT = 1_800_000_000;

type Recorded = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;

const row = Object.freeze({
  appointment_id: APPOINTMENT_ID,
  customer_id: CUSTOMER_ID,
  address_id: ADDRESS_ID,
  direction: "pickup",
  service_area_code: "north",
  scheduled_start_at: new Date(AT * 1_000),
  scheduled_end_at: new Date((AT + 3_600) * 1_000),
  fee_cents: 800,
  status: "scheduled",
  version: 1,
  policy_version: 1,
  created_at: new Date(AT * 1_000),
  updated_at: new Date(AT * 1_000),
  cancelled_at: null,
  cancellation_reason: null,
});

function pool(feature = true, timezone = "Asia/Taipei") {
  const queries: Recorded[] = [];
  const query = async (sql: string, params?: readonly unknown[]) => {
    queries.push(Object.freeze({ sql, params }));
    if (sql.includes("SELECT timezone FROM stores")) {
      return Object.freeze({ rows: Object.freeze([{ timezone }]), rowCount: 1 });
    }
    if (sql.includes("SELECT version FROM delivery_policies")) {
      return Object.freeze({ rows: Object.freeze([{ version: 1 }]), rowCount: 1 });
    }
    if (sql.includes("SELECT delivery FROM store_features")) {
      return Object.freeze({ rows: Object.freeze([{ delivery: feature }]), rowCount: 1 });
    }
    if (sql.includes("COALESCE(bool_or")) {
      return Object.freeze({ rows: Object.freeze([{ count: 0, duplicate: false }]), rowCount: 1 });
    }
    if (sql.includes("INSERT INTO delivery_appointments")) {
      return Object.freeze({ rows: Object.freeze([row]), rowCount: 1 });
    }
    return Object.freeze({ rows: Object.freeze([]), rowCount: 0 });
  };
  const client = Object.freeze({ query, release: () => undefined }) as unknown as PgPoolClient;
  return Object.freeze({
    queries,
    pool: Object.freeze({ connect: async () => client, query }) as unknown as PgPool,
  });
}

const request = Object.freeze({
  appointment_id: APPOINTMENT_ID,
  org_id: ORG_ID,
  store_id: STORE_ID,
  staff_id: STAFF_ID,
  customer_id: CUSTOMER_ID,
  address_id: ADDRESS_ID,
  direction: "pickup" as const,
  service_area_code: "north",
  scheduled_start_at: AT,
  scheduled_end_at: AT + 3_600,
  fee_cents: 800,
  policy_version: 1,
  timezone: "Asia/Taipei",
  max_appointments_per_slot: 1,
  at: AT,
});

test("PostgreSQL create locks timezone, policy and capacity before parameterized insert", async () => {
  const captured = pool();
  const result = await createPgDeliveryAppointmentStore(captured.pool).create(request);
  assert.equal(result.ok, true);
  assert.equal(captured.queries[0]?.sql, "BEGIN");
  assert.equal(captured.queries.at(-1)?.sql, "COMMIT");
  const sql = captured.queries.map(({ sql }) => sql).join("\n");
  assert.match(sql, /FOR SHARE/u);
  assert.match(sql, /SELECT timezone FROM stores/u);
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /COALESCE\(bool_or/u);
  const capacity = captured.queries.find(({ sql: statement }) =>
    statement.includes("COALESCE(bool_or"),
  );
  assert.match(capacity?.sql ?? "", /customer_canonical_group\(\$4::uuid\)/u);
  assert.match(sql, /INSERT INTO delivery_appointments/u);
  assert.doesNotMatch(sql, /fixture-only|private address/u);
  const insert = captured.queries.find(({ sql: statement }) =>
    statement.includes("INSERT INTO delivery_appointments"),
  );
  assert.deepEqual(insert?.params?.slice(0, 5), [
    APPOINTMENT_ID,
    ORG_ID,
    STORE_ID,
    CUSTOMER_ID,
    ADDRESS_ID,
  ]);
});

test("PostgreSQL create fails closed before capacity or insert when feature is disabled", async () => {
  const captured = pool(false);
  const result = await createPgDeliveryAppointmentStore(captured.pool).create(request);
  assert.deepEqual(result, { ok: false, reason: "feature_disabled" });
  assert.equal(
    captured.queries.some(({ sql }) => sql.includes("INSERT INTO delivery_appointments")),
    false,
  );
  assert.equal(captured.queries.at(-1)?.sql, "COMMIT");
});

test("PostgreSQL create fails closed when the locked store timezone changed", async () => {
  const captured = pool(true, "Asia/Shanghai");
  const result = await createPgDeliveryAppointmentStore(captured.pool).create(request);
  assert.deepEqual(result, { ok: false, reason: "policy_changed" });
  assert.equal(
    captured.queries.some(({ sql }) => sql.includes("SELECT version FROM delivery_policies")),
    false,
  );
  assert.equal(
    captured.queries.some(({ sql }) => sql.includes("INSERT INTO delivery_appointments")),
    false,
  );
  assert.equal(captured.queries.at(-1)?.sql, "COMMIT");
});

test("PostgreSQL customer worklist includes the bounded canonical merge group", async () => {
  const captured = pool();
  const result = await createPgDeliveryAppointmentStore(captured.pool).list(ORG_ID, STORE_ID, {
    customer_id: CUSTOMER_ID,
    limit: 50,
  });
  assert.deepEqual(result, []);
  const list = captured.queries.find(({ sql }) => sql.includes("ORDER BY scheduled_start_at"));
  assert.match(list?.sql ?? "", /customer_canonical_group\(\$3::uuid\)/u);
  assert.deepEqual(list?.params, [ORG_ID, STORE_ID, CUSTOMER_ID, 50]);
});
