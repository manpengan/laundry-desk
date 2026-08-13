import assert from "node:assert/strict";
import test from "node:test";

import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgDeliveryAddressResolver } from "./address-resolver.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const ROOT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOURCE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADDRESS_A = "11111111-1111-4111-8111-111111111111";
const ADDRESS_B = "22222222-2222-4222-8222-222222222222";

type Recorded = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;

function client(rows: readonly Readonly<Record<string, unknown>>[]) {
  const queries: Recorded[] = [];
  const sqlClient = Object.freeze({
    async query<TRow>(sql: string, params?: readonly unknown[]) {
      queries.push(Object.freeze({ sql, params }));
      return Object.freeze({ rows: Object.freeze(rows) as readonly TRow[], rowCount: rows.length });
    },
  }) as SqlClient;
  return Object.freeze({ queries, client: sqlClient });
}

test("PostgreSQL resolver locks canonical root, source owner and active address", async () => {
  const captured = client([Object.freeze({ customer_id: ROOT, address_id: ADDRESS_B })]);
  const resolved = await createPgDeliveryAddressResolver().resolve(
    captured.client,
    TENANT,
    SOURCE,
    ADDRESS_B,
  );
  assert.deepEqual(resolved, { customer_id: ROOT, address_id: ADDRESS_B });
  const query = captured.queries[0];
  assert.match(query?.sql ?? "", /JOIN customer_canonical_group\(requested\.id\)/u);
  assert.match(query?.sql ?? "", /FOR SHARE OF requested, root, owner, address_row/u);
  assert.match(query?.sql ?? "", /retired_at IS NULL.*pii_purged_at IS NULL/su);
  assert.deepEqual(query?.params, [TENANT.orgId, SOURCE, ADDRESS_B]);
});

test("PostgreSQL resolver lists bounded addresses from both canonical group members", async () => {
  const captured = client([
    Object.freeze({
      customer_id: ROOT,
      address_id: ADDRESS_A,
      label: "根档案",
      address: "合成地址 A",
      is_default: true,
    }),
    Object.freeze({
      customer_id: ROOT,
      address_id: ADDRESS_B,
      label: "来源档案",
      address: "合成地址 B",
      is_default: false,
    }),
  ]);
  const result = await createPgDeliveryAddressResolver().list(captured.client, TENANT, SOURCE);
  assert.deepEqual(result, {
    customer_id: ROOT,
    addresses: [
      { address_id: ADDRESS_A, label: "根档案", address: "合成地址 A", is_default: true },
      { address_id: ADDRESS_B, label: "来源档案", address: "合成地址 B", is_default: false },
    ],
  });
  const query = captured.queries[0];
  assert.match(query?.sql ?? "", /LEFT JOIN customer_addresses/u);
  assert.match(query?.sql ?? "", /LIMIT 101/u);
  assert.doesNotMatch(query?.sql ?? "", /contact_phone|recipient/u);
  assert.deepEqual(query?.params, [TENANT.orgId, SOURCE]);
});
