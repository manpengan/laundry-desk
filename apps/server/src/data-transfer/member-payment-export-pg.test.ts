import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createCancellationFixture } from "../member/pg-cancellation-test-support.js";
import { EXPORT_TABLES, verifyExportSchema } from "./store-export-policy.js";

const urls = process.env.LAUNDRY_USE_LOCAL_PG === "1" ? resolvePgUrls() : null;
test(
  "whole-store exporter retains balance-payment links with store RLS and no mutation rights",
  { skip: !urls },
  async () => {
    assert.ok(urls);
    const f = await createCancellationFixture(urls);
    try {
      await f.pay(4200);
      await f.transaction((_member, client) => verifyExportSchema(client));
      const table = EXPORT_TABLES.find((entry) => entry.name === "member_payment_links");
      assert.ok(table);
      assert.equal(table.scope, "store");
      assert.deepEqual(
        table.columns.map((column) => column.name),
        ["org_id", "store_id", "payment_id", "ledger_id"],
      );
      const exported = (
        tenant: TenantContext,
        sql = "SELECT org_id,store_id,payment_id,ledger_id FROM member_payment_links",
      ) =>
        withPoolClient(f.adminPool, (client) =>
          withTenantTransaction(client, tenant, async (tx) => {
            await tx.query("SET LOCAL ROLE laundry_store_exporter");
            return tx.query<{
              payment_id: string;
              org_id: string;
              store_id: string;
              ledger_id: string;
            }>(sql);
          }),
        );
      const rows = (await exported(f.tenant)).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.payment_id, (await f.payments())[0]?.payment_id);
      assert.equal((await exported({ ...f.tenant, storeId: randomUUID() })).rows.length, 0);
      assert.equal((await exported({ ...f.tenant, orgId: randomUUID() })).rows.length, 0);
      await assert.rejects(
        exported(f.tenant, "DELETE FROM member_payment_links"),
        /permission denied/u,
      );
      await assert.rejects(
        exported(f.tenant, "UPDATE member_payment_links SET ledger_id=ledger_id"),
        /permission denied/u,
      );
      assert.deepEqual((await exported(f.tenant)).rows, rows);
    } finally {
      await f.cleanup();
    }
  },
);
