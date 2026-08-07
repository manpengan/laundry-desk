import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { createPgMemberStore } from "./pg-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  staffId: "33333333-3333-4333-8333-333333333333",
});

class MissingCustomerClient implements SqlClient {
  readonly statements: string[] = [];

  async query<TRow = unknown>(sql: string): Promise<QueryResult<TRow>> {
    this.statements.push(sql);
    return Object.freeze({ rows: Object.freeze([]) as readonly TRow[], rowCount: 0 });
  }
}

test("account open treats merged or anonymized customers as missing under a key-share lock", async () => {
  const client = new MissingCustomerClient();
  const store = createPgMemberStore(client, TENANT);

  const outcome = await store.openAccount({
    customer_id: "44444444-4444-4444-8444-444444444444",
    store_id: TENANT.storeId,
    at: 1_780_000_000,
  });

  assert.deepEqual(outcome, { ok: false, reason: "customer_not_found" });
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0] ?? "", /merged_into_id IS NULL/);
  assert.match(client.statements[0] ?? "", /anonymized_at IS NULL/);
  assert.match(client.statements[0] ?? "", /FOR KEY SHARE/);
});
