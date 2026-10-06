import assert from "node:assert/strict";
import { test } from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient } from "../db/types.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { reconcileChannelBill } from "./reconciliation.js";
import {
  listReconciliations,
  readReconciliation,
  reviewReconciliation,
} from "./reconciliation-history.js";

const urls = resolvePgUrls();
test(
  "PG reconciliation pages beyond 100, tenant isolation, app-role CAS and audit rollback",
  { skip: !urls },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const pool = createPgPool({ connectionString: urls.app });
    try {
      const tenant = await seedMigrationTenant(admin),
        other = await seedMigrationTenant(admin);
      const tx = <T>(run: (client: SqlClient) => Promise<T>) =>
        withClient(pool, (client) => withTenantTransaction(client, tenant, run));
      const bill = await tx((client) =>
        reconcileChannelBill(client, tenant, {
          channel: "wechat",
          business_date: "2026-10-06",
          rows: Array.from({ length: 151 }, (_, index) => ({
            merchant_order: `LD${String(index).padStart(20, "0")}`,
            provider_order: `P${index}`,
            amount_cents: 100,
            kind: "payment",
            merchant_refund: null,
          })),
        }),
      );
      assert.equal(bill.mismatches.length, 151);
      const id = bill.reconciliation_id;
      const history = await tx((client) =>
        listReconciliations(client, tenant, { channel: "wechat" }),
      );
      assert.equal(history.total, 1);
      assert.equal(history.rows[0]?.reconciliation_id, id);
      assert.equal(
        (await tx((client) => listReconciliations(client, tenant, { date_from: "2026-10-07" })))
          .total,
        0,
      );
      const page = await tx((client) =>
        readReconciliation(client, tenant, { reconciliation_id: id, offset: 100 }),
      );
      assert.equal(page.rows[0]?.index, 100);
      assert.equal(page.rows.length, 50);
      await assert.rejects(
        withClient(pool, (client) =>
          withTenantTransaction(client, other, (inner) =>
            readReconciliation(inner, other, { reconciliation_id: id }),
          ),
        ),
        /RESOURCE_UNAVAILABLE/u,
      );
      const input = {
        reconciliation_id: id,
        index: 100,
        state: "investigating",
        note: "合成数据复核",
        expected_version: 0,
      };
      const results = await Promise.allSettled([
        tx((client) => reviewReconciliation(client, tenant, input)),
        tx((client) => reviewReconciliation(client, tenant, input)),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const updated = await tx((client) =>
        reviewReconciliation(client, tenant, { ...input, state: "resolved", expected_version: 1 }),
      );
      assert.equal(updated.review.version, 2);
      const before = await tx((client) =>
        client.query<{ count: string }>("SELECT count(*) FROM audit_log WHERE entity_id=$1", [id]),
      );
      await assert.rejects(
        tx(async (client) => {
          await reviewReconciliation(client, tenant, { ...input, index: 101 });
          throw new Error("rollback-test");
        }),
        /rollback-test/u,
      );
      const after = await tx((client) =>
        client.query<{ count: string }>("SELECT count(*) FROM audit_log WHERE entity_id=$1", [id]),
      );
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
      const detail = await tx((client) =>
        readReconciliation(client, tenant, { reconciliation_id: id, offset: 100 }),
      );
      assert.equal(detail.rows[0]?.review.state, "resolved");
      assert.equal(detail.rows[1]?.review.version, 0);
      assert.equal(detail.summary.source_sha256, bill.source_sha256);
      await assert.rejects(
        tx((client) =>
          client.query("UPDATE payment_channel_reconciliations SET matched_count=99 WHERE id=$1", [
            id,
          ]),
        ),
        /permission denied/u,
      );
      await assert.rejects(
        tx((client) =>
          client.query(
            "DELETE FROM payment_channel_reconciliation_reviews WHERE reconciliation_id=$1",
            [id],
          ),
        ),
        /permission denied/u,
      );
    } finally {
      await pool.end();
      await admin.end();
    }
  },
);
