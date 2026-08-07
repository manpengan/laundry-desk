import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { createPgOwnerDashboardSource } from "./pg-source.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

class OperationsClient implements SqlClient {
  readonly queries: Array<Readonly<{ sql: string; params?: readonly unknown[] }>> = [];

  constructor(private readonly row: Readonly<Record<string, number | string>>) {}

  async query<TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<TRow>> {
    this.queries.push(Object.freeze({ sql, ...(params === undefined ? {} : { params }) }));
    return Object.freeze({ rows: Object.freeze([this.row as TRow]), rowCount: 1 });
  }
}

function request(client: SqlClient) {
  return Object.freeze({
    client,
    tenant: TENANT,
    businessDate: "2026-08-07",
    dayStartedAt: new Date("2026-08-06T19:00:00.000Z"),
    nextDayStartedAt: new Date("2026-08-07T19:00:00.000Z"),
    overdueCutoff: new Date("2026-07-08T18:30:00.000Z"),
  });
}

test("PostgreSQL owner-dashboard operations are parameterized and tenant-scoped in every CTE", async () => {
  const client = new OperationsClient({
    picked_up_garment_count: "7",
    new_receivable_cents: "4500",
    new_receivable_order_count: "2",
    overdue_garment_count: "9",
    overdue_order_count: "4",
  });
  const value = await createPgOwnerDashboardSource().readOperations(request(client));
  assert.deepEqual(value, {
    pickedUpGarmentCount: 7,
    newReceivableCents: 4_500,
    newReceivableOrderCount: 2,
    overdueGarmentCount: 9,
    overdueOrderCount: 4,
  });

  const query = client.queries[0];
  assert.ok(query);
  assert.equal((query.sql.match(/org_id = \$1::uuid/gu) ?? []).length, 3);
  assert.equal((query.sql.match(/store_id = \$2::uuid/gu) ?? []).length, 3);
  assert.doesNotMatch(query.sql, new RegExp(TENANT.orgId, "u"));
  assert.deepEqual(query.params, [
    TENANT.orgId,
    TENANT.storeId,
    "2026-08-07",
    "2026-08-06T19:00:00.000Z",
    "2026-08-07T19:00:00.000Z",
    "2026-07-08T18:30:00.000Z",
  ]);
});

test("PostgreSQL owner-dashboard operations reject corrupt negative aggregates", async () => {
  const client = new OperationsClient({
    picked_up_garment_count: "-1",
    new_receivable_cents: "0",
    new_receivable_order_count: "0",
    overdue_garment_count: "0",
    overdue_order_count: "0",
  });
  await assert.rejects(
    () => createPgOwnerDashboardSource().readOperations(request(client)),
    /picked_up_garment_count/u,
  );
});
