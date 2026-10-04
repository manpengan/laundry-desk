import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient } from "../db/types.js";

const urls = resolvePgUrls(process.env);
test(
  "real PG AI config enforces current-session tenant, admin, CAS, budget and atomic audit",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    const make = () => ({
      orgId: randomUUID(),
      storeId: randomUUID(),
      staffId: randomUUID(),
      sessionId: randomUUID(),
      deviceId: randomUUID(),
    });
    const owner = make();
    const foreign = make();
    const clerk = { ...owner, staffId: randomUUID(), sessionId: randomUUID() };
    const fixtures = [owner, foreign];
    const bind = <T>(who: typeof owner, operation: (client: SqlClient) => Promise<T>) =>
      withClient(app, (client) =>
        withTenantTransaction(client, who, async (transaction) => {
          await transaction.query("SELECT set_config('app.auth_session_id',$1,true)", [
            who.sessionId,
          ]);
          return operation(transaction);
        }),
      );
    const save = (client: SqlClient, session: string, version: number, enabled = false) =>
      client.query<{ config: Record<string, unknown> }>(
        "SELECT public.ai_runtime_config_set($1::uuid,$2,'deepseek','fixture-model',$3,1000000,2000000,3000000,$4::uuid) AS config",
        [session, version, enabled, randomUUID()],
      );
    try {
      for (const f of fixtures) {
        await admin.query(
          "INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,$2,'AI fixture',now(),now())",
          [f.orgId, `ai-${f.orgId}`],
        );
        await admin.query(
          "INSERT INTO stores(id,org_id,code,name,created_at,updated_at) VALUES($1,$2,'main','AI fixture',now(),now())",
          [f.storeId, f.orgId],
        );
      }
      for (const f of [owner, foreign, clerk]) {
        await admin.query(
          `INSERT INTO staffs(id,org_id,username,password_hash,display_name,is_active,permission_version,created_at,updated_at)
        VALUES($1,$2,$3,'synthetic','AI fixture',true,1,now(),now())`,
          [f.staffId, f.orgId, `ai-${f.staffId}`],
        );
        await admin.query(
          `INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_active,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,true,now(),now())`,
          [randomUUID(), f.orgId, f.storeId, f.staffId, f === clerk ? "staff" : "admin"],
        );
        await admin.query(
          `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at)
        VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
          [f.sessionId, f.orgId, f.storeId, f.staffId, f.deviceId],
        );
      }
      const first = await bind(owner, (client) => save(client, owner.sessionId, 0));
      assert.equal(first.rows[0]?.config.version, 1);
      assert.equal(first.rows[0]?.config.enabled, false);
      await assert.rejects(
        bind(owner, (client) => save(client, owner.sessionId, 0)),
        { code: "40001" },
      );
      await assert.rejects(
        bind(clerk, (client) => save(client, clerk.sessionId, 1)),
        { code: "42501" },
      );
      await assert.rejects(
        bind(foreign, (client) => save(client, owner.sessionId, 1)),
        { code: "42501" },
      );
      await assert.rejects(
        bind(owner, (client) => client.query("UPDATE public.ai_safety_policies SET enabled=true")),
        { code: "42501" },
      );
      await assert.rejects(
        bind(owner, (client) => save(client, owner.sessionId, 1, true)),
        { code: "23514" },
      );
      const other = await bind(foreign, (client) =>
        client.query<{ config: unknown }>(
          "SELECT public.ai_runtime_config_get($1::uuid) AS config",
          [foreign.sessionId],
        ),
      );
      assert.equal(other.rows[0]?.config, null);
      const second = await bind(owner, (client) => save(client, owner.sessionId, 1));
      assert.equal(second.rows[0]?.config.version, 2);
      const audit = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM audit_log WHERE org_id=$1 AND command='ai.runtime.configure'",
        [owner.orgId],
      );
      assert.equal(audit.rows[0]?.count, "2");
      const policy = await admin.query<{ price: string }>(
        "SELECT input_micros_per_million::text AS price FROM ai_safety_policies WHERE org_id=$1",
        [owner.orgId],
      );
      assert.equal(policy.rows[0]?.price, "2000000");
      await admin.query("UPDATE sessions SET status='revoked' WHERE id=$1", [owner.sessionId]);
      await assert.rejects(
        bind(owner, (client) => save(client, owner.sessionId, 2)),
        { code: "42501" },
      );
    } finally {
      // The integration runner owns its disposable database; remove only this test's identities.
      const ids = fixtures.map((f) => f.orgId);
      for (const table of [
        "audit_log",
        "ai_safety_policies",
        "sessions",
        "staff_store_roles",
        "staffs",
        "stores",
        "customer_privacy_hmac_keys",
      ]) {
        await admin.query(`DELETE FROM public.${table} WHERE org_id=ANY($1::uuid[])`, [ids]);
      }
      await admin.query("DELETE FROM orgs WHERE id=ANY($1::uuid[])", [ids]);
      await Promise.all([app.end(), admin.end()]);
    }
  },
);
