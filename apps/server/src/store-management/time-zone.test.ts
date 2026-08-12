import assert from "node:assert/strict";
import test from "node:test";

import type { SqlClient, TenantContext } from "../db/types.js";
import { readPgStoreTimeZone } from "./time-zone.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

test("PostgreSQL timezone lookup is current-store scoped and validates IANA names", async () => {
  const parameters: (readonly unknown[])[] = [];
  const client = Object.freeze({
    query: async <TRow>(_sql: string, params?: readonly unknown[]) => {
      parameters.push(Object.freeze([...(params ?? [])]));
      return Object.freeze({
        rows: Object.freeze([{ timezone: "Pacific/Kiritimati" }]) as unknown as readonly TRow[],
        rowCount: 1,
      });
    },
  }) satisfies SqlClient;

  assert.equal(await readPgStoreTimeZone(client, TENANT), "Pacific/Kiritimati");
  assert.deepEqual(parameters, [[TENANT.orgId, TENANT.storeId]]);

  const invalid = Object.freeze({
    query: async <TRow>() =>
      Object.freeze({
        rows: Object.freeze([{ timezone: "not/a-zone" }]) as unknown as readonly TRow[],
        rowCount: 1,
      }),
  }) satisfies SqlClient;
  await assert.rejects(() => readPgStoreTimeZone(invalid, TENANT), /timezone/iu);
});
