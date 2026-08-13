import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgPendingActionStore, type PendingActionStore } from "../pending-actions/index.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import { createPgMarketingStore } from "./pg-store.js";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const CAMPAIGN_ID = "71000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "71000000-0000-4000-8000-000000000002";
const LEDGER_ID = "71000000-0000-4000-8000-000000000003";
const SOURCE_ID = "71000000-0000-4000-8000-000000000004";
const PENDING_KEY = "71000000-0000-4000-8000-000000000007";
const RULE = Object.freeze({
  customer_age: Object.freeze({ kind: "any" }),
  membership: Object.freeze({ kind: "any" }),
  order_activity: Object.freeze({ kind: "none" }),
});
const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["marketing_manage"]),
});
const SET_INPUT = Object.freeze({
  expected_version: 0,
  code: "item7_pending_retry",
  name: "Item 7 pending retry",
  status: "draft" as const,
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  budget_limit_cents: 50_000,
  recipient_limit: 10,
  audience_rule: RULE,
});

const withAppTransaction = <T>(
  pool: PgPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> => withPoolClient(pool, (client) => withTenantTransaction(client, TENANT, operation));

function rejectsWith(code: string, message: RegExp) {
  return (error: unknown): boolean => {
    const pgError = error as Readonly<{ code?: unknown; message?: unknown }>;
    assert.equal(pgError.code, code);
    assert.match(String(pgError.message), message);
    return true;
  };
}

async function cleanup(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `DELETE FROM ai_pending_actions
        WHERE command='marketing.campaign.set' AND idempotency_key=$1`,
      [PENDING_KEY],
    );
    await client.query("DELETE FROM campaign_budget_ledger WHERE id = $1", [LEDGER_ID]);
    await client.query("DELETE FROM campaign_audience_snapshots WHERE id = $1", [SNAPSHOT_ID]);
    await client.query("DELETE FROM campaigns WHERE id = $1", [CAMPAIGN_ID]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function confirmationRef(result: CommandResult): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok || result.error.code !== "POLICY_CONFIRMATION_REQUIRED") {
    return assert.fail(`confirmation required: ${JSON.stringify(result)}`);
  }
  assert.equal(result.error.detail?.kind, "confirmation");
  if (result.error.detail?.kind !== "confirmation") return assert.fail("missing confirmation");
  return result.error.detail.confirm_ref;
}

function runFirstHop(pool: PgPool, pendingStore: PendingActionStore): Promise<CommandResult> {
  const bus = createRegisteredM1Bus(
    {
      marketing: Object.freeze({
        store: createPgMarketingStore(),
        features: createMemoryFeaturesStore({ [DEMO_STORE_ID]: { marketing: true } }),
        now: () => new Date("2026-08-13T02:00:00.000Z"),
      }),
    },
    pendingStore,
  );
  return withPoolClient(pool, (client) =>
    executeCommand(client, TENANT, "marketing.campaign.set", SET_INPUT, {
      registry: bus.registry,
      actor: ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyKey: PENDING_KEY,
    }),
  );
}

async function insertCampaign(
  pool: PgPool,
): Promise<Readonly<{ digest: string; updatedAt: Date }>> {
  const result = await withAppTransaction(pool, (client) =>
    client.query<Readonly<{ audience_rule_sha256: string; updated_at: Date }>>(
      `INSERT INTO campaigns
       (id, org_id, store_id, code, name, status, starts_at, ends_at,
        audience_rule, audience_rule_sha256, recipient_limit, budget_limit_cents,
        version, created_by_staff_id, created_at, updated_by_staff_id, updated_at)
       VALUES ($1,$2,$3,'item7_pg_guard','Item 7 guard','draft',
               statement_timestamp() + interval '1 day',
               statement_timestamp() + interval '30 days',
               $4::jsonb,$5,10,100000,1,$6,'2000-01-01',$6,'2000-01-01')
       RETURNING audience_rule_sha256, updated_at`,
      [
        CAMPAIGN_ID,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        JSON.stringify(RULE),
        "0".repeat(64),
        DEMO_ADMIN_ID,
      ],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("campaign insert failed");
  return Object.freeze({ digest: row.audience_rule_sha256, updatedAt: row.updated_at });
}

test(
  "real PostgreSQL marketing writers bind actor, version and database-owned time",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    try {
      await cleanup(adminPool);
      const created = await insertCampaign(appPool);
      assert.notEqual(created.digest, "0".repeat(64));
      assert.ok(created.updatedAt.getTime() > Date.parse("2000-01-01"));

      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE campaigns SET version=3, updated_by_staff_id=$4
                WHERE org_id=$1 AND store_id=$2 AND id=$3`,
              [DEMO_ORG_ID, DEMO_STORE_ID, CAMPAIGN_ID, DEMO_ADMIN_ID],
            ),
          ),
        rejectsWith("23514", /MARKETING_VERSION_INVALID/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE campaigns SET version=2, updated_by_staff_id=$4
                WHERE org_id=$1 AND store_id=$2 AND id=$3`,
              [DEMO_ORG_ID, DEMO_STORE_ID, CAMPAIGN_ID, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /MARKETING_ACTOR_UNAVAILABLE/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `INSERT INTO campaign_audience_snapshots
               (id,org_id,store_id,campaign_id,campaign_version,audience_rule_sha256,
                audience_digest,recipient_count,created_by_staff_id,created_at)
               VALUES ($1,$2,$3,$4,1,$5,$6,1,$7,'2000-01-01')`,
              [
                SNAPSHOT_ID,
                DEMO_ORG_ID,
                DEMO_STORE_ID,
                CAMPAIGN_ID,
                created.digest,
                "a".repeat(64),
                DEMO_STAFF_A_ID,
              ],
            ),
          ),
        rejectsWith("42501", /MARKETING_ACTOR_UNAVAILABLE/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `INSERT INTO campaign_budget_ledger
               (id,org_id,store_id,campaign_id,kind,source_id,amount_cents,staff_id,at)
               VALUES ($1,$2,$3,$4,'coupon_issue',$5,100,$6,'2000-01-01')`,
              [LEDGER_ID, DEMO_ORG_ID, DEMO_STORE_ID, CAMPAIGN_ID, SOURCE_ID, DEMO_ADMIN_ID],
            ),
          ),
        rejectsWith("42501", /permission denied for table campaign_budget_ledger/u),
      );

      const pendingStore = createPgPendingActionStore(appPool);
      const [left, right] = await Promise.all([
        runFirstHop(appPool, pendingStore),
        runFirstHop(appPool, pendingStore),
      ]);
      assert.equal(confirmationRef(left), confirmationRef(right));
      const active = await adminPool.query<Readonly<{ count: string }>>(
        `SELECT count(*)::text AS count FROM ai_pending_actions
          WHERE org_id=$1 AND store_id=$2 AND command='marketing.campaign.set'
            AND idempotency_key=$3 AND status='pending'`,
        [DEMO_ORG_ID, DEMO_STORE_ID, PENDING_KEY],
      );
      assert.equal(active.rows[0]?.count, "1");
    } finally {
      await cleanup(adminPool);
      await appPool.end();
      await adminPool.end();
    }
  },
);
