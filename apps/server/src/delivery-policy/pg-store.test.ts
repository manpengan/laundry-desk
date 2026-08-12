import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgDeliveryPolicyStore } from "./pg-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const UPDATED_AT = Math.floor(Date.parse("2026-08-13T00:00:00.000Z") / 1_000);

type RecordedQuery = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;
type QueryAnswer = Readonly<{ rows: readonly unknown[]; rowCount: number }>;

function createCapturingPool(answer: (sql: string) => QueryAnswer) {
  const queries: RecordedQuery[] = [];
  const query = async (sql: string, params?: readonly unknown[]): Promise<QueryAnswer> => {
    queries.push(Object.freeze({ sql, params }));
    return answer(sql);
  };
  const client = Object.freeze({
    query,
    release: () => undefined,
  }) as unknown as PgPoolClient;
  const pool = Object.freeze({
    connect: async () => client,
    query,
  }) as unknown as PgPool;
  return Object.freeze({ pool, queries });
}

const ROW = Object.freeze({
  accepting_appointments: true,
  minimum_lead_minutes: 120,
  maximum_advance_days: 14,
  slot_minutes: 60,
  max_appointments_per_slot: 3,
  service_areas_json: Object.freeze([
    Object.freeze({ code: "north", name: "北区", fee_cents: 800, is_active: true }),
  ]),
  weekly_windows_json: Object.freeze([
    Object.freeze({ weekday: 1, start_minute: 540, end_minute: 1_020 }),
  ]),
  version: 1,
  updated_at: new Date(UPDATED_AT * 1_000),
});

test("PostgreSQL policy insert is tenant-scoped, versioned and never changes features", async () => {
  const captured = createCapturingPool((sql) => {
    if (sql.includes("INSERT INTO delivery_policies")) return { rows: [ROW], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const store = createPgDeliveryPolicyStore(captured.pool);
  const change = await store.set({
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    staff_id: TENANT.staffId,
    expected_version: 0,
    accepting_appointments: true,
    minimum_lead_minutes: 120,
    maximum_advance_days: 14,
    slot_minutes: 60,
    max_appointments_per_slot: 3,
    service_areas: ROW.service_areas_json,
    weekly_windows: ROW.weekly_windows_json,
    updated_at: UPDATED_AT,
  });

  assert.equal(change?.before.version, 0);
  assert.equal(change?.after.version, 1);
  const insert = captured.queries.find(({ sql }) => sql.includes("INSERT INTO delivery_policies"));
  assert.ok(insert);
  assert.deepEqual(insert.params?.slice(0, 2), [TENANT.orgId, TENANT.storeId]);
  assert.equal(insert.params?.[7], JSON.stringify(ROW.service_areas_json));
  assert.equal(insert.params?.[8], JSON.stringify(ROW.weekly_windows_json));
  assert.equal(
    captured.queries.some(({ sql }) => sql.includes("store_features")),
    false,
  );
  assert.equal(captured.queries.at(0)?.sql, "BEGIN");
  assert.equal(captured.queries.at(-1)?.sql, "COMMIT");
});

test("PostgreSQL policy store rejects stale version and active-transaction scope switching", async () => {
  const captured = createCapturingPool((sql) =>
    sql.includes("FROM delivery_policies")
      ? { rows: [{ ...ROW, version: 2 }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  const store = createPgDeliveryPolicyStore(captured.pool);
  const stale = await store.set({
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    staff_id: TENANT.staffId,
    expected_version: 1,
    accepting_appointments: false,
    minimum_lead_minutes: 120,
    maximum_advance_days: 14,
    slot_minutes: 60,
    max_appointments_per_slot: 1,
    service_areas: Object.freeze([]),
    weekly_windows: Object.freeze([]),
    updated_at: UPDATED_AT,
  });
  assert.equal(stale, null);
  assert.equal(
    captured.queries.some(({ sql }) => sql.includes("UPDATE delivery_policies")),
    false,
  );

  const transactionClient = Object.freeze({
    memoryTransaction: true as const,
    query: async () => Object.freeze({ rows: Object.freeze([]), rowCount: 0 }),
  }) satisfies SqlClient;
  await assert.rejects(
    withTenantTransaction(transactionClient, TENANT, () =>
      store.get(TENANT.orgId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ),
    /Repository store scope does not match authenticated tenant/u,
  );
});
