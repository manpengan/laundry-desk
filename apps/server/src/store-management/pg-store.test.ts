import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { createPgStoreManagementStore } from "./pg-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

type Row = Readonly<{
  id: string;
  code: string;
  name: string;
  timezone: string;
  profile_version: number;
  updated_at: string;
}>;

function result<TRow>(rows: readonly TRow[]): QueryResult<TRow> {
  return Object.freeze({ rows: Object.freeze([...rows]), rowCount: rows.length });
}

function storeRow(index: number, current = false): Row {
  const suffix = index.toString().padStart(12, "0");
  return Object.freeze({
    id: current ? TENANT.storeId : `dddddddd-dddd-4ddd-8ddd-${suffix}`,
    code: current ? "zz-current" : `store-${index.toString().padStart(3, "0")}`,
    name: current ? "当前门店" : `门店 ${index}`,
    timezone: "Asia/Shanghai",
    profile_version: 1,
    updated_at: "2026-08-11T00:00:00.000Z",
  });
}

test("PostgreSQL directory reauthorizes every candidate and retains current store when truncated", async () => {
  const rows = Object.freeze([
    ...Array.from({ length: 50 }, (_, index) => storeRow(index)),
    storeRow(999, true),
  ]);
  const statements: Readonly<{ sql: string; params: readonly unknown[] | undefined }>[] = [];
  const client: SqlClient = Object.freeze({
    query: async <TRow>(sql: string, params?: readonly unknown[]) => {
      statements.push(Object.freeze({ sql, params }));
      if (sql.includes("FROM stores AS store") && sql.includes("LIMIT")) {
        return result(rows as unknown as readonly TRow[]);
      }
      if (sql.includes("SELECT EXISTS")) {
        return result([{ authorized: true }] as unknown as readonly TRow[]);
      }
      return result<TRow>([]);
    },
  });

  const directory = await createPgStoreManagementStore().listAuthorized(client, TENANT);
  assert.equal(directory.truncated, true);
  assert.equal(directory.stores.length, 50);
  assert.equal(directory.stores.filter((store) => store.isCurrent).length, 1);
  assert.equal(directory.stores.at(-1)?.storeCode, "zz-current");
  assert.deepEqual(
    directory.stores.map((store) => store.storeCode),
    [...directory.stores.map((store) => store.storeCode)].sort(),
  );

  const authorizationChecks = statements.filter((entry) => entry.sql.includes("SELECT EXISTS"));
  assert.equal(authorizationChecks.length, rows.length);
  const gucWrites = statements.filter((entry) => entry.sql.includes("set_config('app.store_id'"));
  assert.equal(gucWrites.length, rows.length + 1);
  assert.deepEqual(gucWrites.at(-1)?.params, [TENANT.storeId]);
});

test("PostgreSQL directory filters unauthorized stores and restores the current store GUC", async () => {
  const hidden = storeRow(1);
  const current = storeRow(2, true);
  const gucValues: unknown[] = [];
  const client: SqlClient = Object.freeze({
    query: async <TRow>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM stores AS store") && sql.includes("LIMIT")) {
        return result([hidden, current] as unknown as readonly TRow[]);
      }
      if (sql.includes("set_config('app.store_id'")) {
        gucValues.push(params?.[0]);
        return result<TRow>([]);
      }
      if (sql.includes("SELECT EXISTS")) {
        return result([
          { authorized: params?.[1] === TENANT.storeId },
        ] as unknown as readonly TRow[]);
      }
      return result<TRow>([]);
    },
  });

  const directory = await createPgStoreManagementStore().listAuthorized(client, TENANT);
  assert.deepEqual(
    directory.stores.map((store) => store.storeCode),
    ["zz-current"],
  );
  assert.deepEqual(gucValues, [hidden.id, current.id, TENANT.storeId]);
});

test("PostgreSQL directory fails before scope switching when the organization is too large", async () => {
  const rows = Object.freeze(Array.from({ length: 201 }, (_, index) => storeRow(index)));
  const statements: string[] = [];
  const client: SqlClient = Object.freeze({
    query: async <TRow>(sql: string) => {
      statements.push(sql);
      return result(rows as unknown as readonly TRow[]);
    },
  });

  await assert.rejects(
    () => createPgStoreManagementStore().listAuthorized(client, TENANT),
    /candidate limit exceeded/iu,
  );
  assert.equal(statements.length, 1);
});

test("PostgreSQL rename is current-store scoped and uses optimistic concurrency", async () => {
  const before = storeRow(2, true);
  const after = Object.freeze({
    ...before,
    name: "新门店名",
    profile_version: 2,
    updated_at: "2026-08-11T03:04:05.000Z",
  });
  const statements: Readonly<{ sql: string; params: readonly unknown[] | undefined }>[] = [];
  const client: SqlClient = Object.freeze({
    query: async <TRow>(sql: string, params?: readonly unknown[]) => {
      statements.push(Object.freeze({ sql, params }));
      if (sql.includes("FOR UPDATE")) return result([before] as unknown as readonly TRow[]);
      if (sql.includes("UPDATE stores")) return result([after] as unknown as readonly TRow[]);
      return result<TRow>([]);
    },
  });

  const at = new Date("2026-08-11T03:04:05.000Z");
  const changed = await createPgStoreManagementStore().updateCurrent(client, TENANT, {
    expectedProfileVersion: 1,
    storeName: "新门店名",
    at,
  });
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.equal(changed.before.storeName, "当前门店");
  assert.equal(changed.after.storeName, "新门店名");
  assert.equal(changed.after.profileVersion, 2);

  const update = statements.find((entry) => entry.sql.includes("UPDATE stores"));
  assert.match(update?.sql ?? "", /org_id = \$1::uuid[\s\S]*id = \$2::uuid/iu);
  assert.match(update?.sql ?? "", /profile_version = \$5::integer/iu);
  assert.deepEqual(update?.params, [TENANT.orgId, TENANT.storeId, "新门店名", at.toISOString(), 1]);
});

test("PostgreSQL rename does not update on stale or unchanged profiles", async () => {
  for (const input of [
    { expectedProfileVersion: 2, storeName: "新名称", reason: "stale" as const },
    { expectedProfileVersion: 1, storeName: "当前门店", reason: "unchanged" as const },
  ]) {
    const statements: string[] = [];
    const client: SqlClient = Object.freeze({
      query: async <TRow>(sql: string) => {
        statements.push(sql);
        return result([storeRow(2, true)] as unknown as readonly TRow[]);
      },
    });
    const outcome = await createPgStoreManagementStore().updateCurrent(client, TENANT, {
      expectedProfileVersion: input.expectedProfileVersion,
      storeName: input.storeName,
      at: new Date("2026-08-11T03:04:05.000Z"),
    });
    assert.deepEqual(outcome, { ok: false, reason: input.reason });
    assert.equal(
      statements.some((sql) => sql.includes("UPDATE stores")),
      false,
    );
  }
});
