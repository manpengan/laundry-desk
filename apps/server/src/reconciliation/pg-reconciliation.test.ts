import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createPgEdgeConflictReadPort, createPgReconciliationSource } from "./pg-source.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});
const ADMIN: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["accounting_read", "ledger_export", "edge_conflict_resolve"]),
});
const UNPRIVILEGED: ActorContext = Object.freeze({
  ...ADMIN,
  permissions: Object.freeze(["order_write"]),
});
const BUSINESS_DATE = "2099-12-31";

maybe(
  "real PG reconciliation bus enforces RBAC, audits export and rejects unknown discard",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    try {
      await seedPgTestIdentityFixture(adminPool);
      const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({
        reconciliation: Object.freeze({
          source: createPgReconciliationSource(LOCAL_PROFILE.timezone),
          edgeConflicts: createPgEdgeConflictReadPort(),
          timeZone: LOCAL_PROFILE.timezone,
        }),
      });

      const denied = await withPoolClient(appPool, (sql) =>
        executeQuery(
          sql,
          TENANT,
          "reconciliation.day.get",
          { business_date: BUSINESS_DATE },
          { registry: queryRegistry, actor: UNPRIVILEGED },
        ),
      );
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.error.code, "PERMISSION_DENIED");

      const queried = await withPoolClient(appPool, (sql) =>
        executeQuery(
          sql,
          TENANT,
          "reconciliation.day.get",
          { business_date: BUSINESS_DATE },
          { registry: queryRegistry, actor: ADMIN },
        ),
      );
      assert.equal(queried.ok, true, JSON.stringify(queried));
      if (queried.ok) {
        const result = queried.data.result as {
          business_date: string;
          orders: { count: number };
        };
        assert.equal(result.business_date, BUSINESS_DATE);
        assert.equal(result.orders.count, 0);
      }

      const exportInput = Object.freeze({ business_date: BUSINESS_DATE, format: "csv" });
      const gatedExport = await withPoolClient(appPool, (sql) =>
        executeCommand(sql, TENANT, "reconciliation.export", exportInput, {
          registry,
          actor: ADMIN,
          chainHooks,
        }),
      );
      assert.equal(gatedExport.ok, false, JSON.stringify(gatedExport));
      const exportDetail =
        !gatedExport.ok && "detail" in gatedExport.error ? gatedExport.error.detail : undefined;
      if (exportDetail?.kind !== "confirmation") {
        assert.fail("reconciliation.export must return a confirmation reference");
      }
      const exported = await withPoolClient(appPool, (sql) =>
        executeCommand(
          sql,
          TENANT,
          "reconciliation.export",
          {},
          {
            registry,
            actor: ADMIN,
            chainHooks,
            confirmRef: exportDetail.confirm_ref,
          },
        ),
      );
      assert.equal(exported.ok, true, JSON.stringify(exported));

      const audits = await withPoolClient(appPool, (sql) =>
        withTenantTransaction(sql, TENANT, (tx) =>
          tx.query<{ command: string; after_json: string | null }>(
            `SELECT command, after_json
             FROM audit_log
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND command = 'reconciliation.export'
            ORDER BY at DESC
            LIMIT 1`,
            [TENANT.orgId, TENANT.storeId],
          ),
        ),
      );
      assert.equal(audits.rows[0]?.command, "reconciliation.export");
      assert.doesNotMatch(audits.rows[0]?.after_json ?? "", /"csv"\s*:/u);

      const discardInput = Object.freeze({
        queue_id: "10000000-0000-4000-8000-000000000099",
        reason: "operator confirmed no matching conflict",
        confirm: "DISCARD",
      });
      const gatedDiscard = await withPoolClient(appPool, (sql) =>
        executeCommand(sql, TENANT, "edge.conflict.discard", discardInput, {
          registry,
          actor: ADMIN,
          chainHooks,
        }),
      );
      assert.equal(gatedDiscard.ok, false, JSON.stringify(gatedDiscard));
      const discardDetail =
        !gatedDiscard.ok && "detail" in gatedDiscard.error ? gatedDiscard.error.detail : undefined;
      if (discardDetail?.kind !== "confirmation") {
        assert.fail("edge.conflict.discard must return a confirmation reference");
      }
      const discarded = await withPoolClient(appPool, (sql) =>
        executeCommand(
          sql,
          TENANT,
          "edge.conflict.discard",
          {},
          {
            registry,
            actor: ADMIN,
            chainHooks,
            confirmRef: discardDetail.confirm_ref,
          },
        ),
      );
      assert.equal(discarded.ok, false);
      if (!discarded.ok) assert.equal(discarded.error.code, "RESOURCE_UNAVAILABLE");
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  },
);
