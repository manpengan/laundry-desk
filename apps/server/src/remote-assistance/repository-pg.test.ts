import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { createAssistanceRepository, type AssistanceGrant } from "./repository.js";
import { actorFixture } from "./test-fixture.js";

const urls = resolvePgUrls();
test(
  "real app-role PG assistance revalidates authority, isolates tenants, rejects replay, and atomically audits",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin }),
      app = createPgPool({ connectionString: urls.app });
    try {
      const tenant = await seedMigrationTenant(admin),
        other = await seedMigrationTenant(admin),
        base = actorFixture();
      const auth = {
        ...base,
        session: {
          ...base.session,
          org_id: tenant.orgId,
          store_id: tenant.storeId,
          staff_id: tenant.staffId,
        },
        authority: { ...base.authority, staff_id: tenant.staffId },
      };
      await admin.query(
        "INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())",
        [
          auth.session.session_id,
          tenant.orgId,
          tenant.storeId,
          tenant.staffId,
          auth.session.device_id,
        ],
      );
      await admin.query(
        "INSERT INTO refresh_families(id,session_id,org_id,store_id,status,created_at) VALUES($1,$2,$3,$4,'active',now())",
        [auth.session.family_id, auth.session.session_id, tenant.orgId, tenant.storeId],
      );
      const repository = createAssistanceRepository(app, {
        LAUNDRY_RUNTIME_RELEASE: "0.2.0-win-dev",
        LAUNDRY_RUNTIME_CONTRACTS_SHA256: "a".repeat(64),
        LAUNDRY_RUNTIME_SCHEMA_SHA256: "b".repeat(64),
        LAUNDRY_RUNTIME_MIGRATIONS_SHA256: "c".repeat(64),
        LAUNDRY_RUNTIME_MIGRATION_HEAD: "0076_remote_assistance.sql",
      });
      const approvedAt = Date.now(),
        grant: AssistanceGrant = {
          id: randomUUID(),
          auth,
          approvedAt,
          expiresAt: approvedAt + 3600000,
        };
      await repository.approve(grant);
      await repository.verify(grant);
      const request = randomUUID();
      assert.deepEqual(await repository.execute(grant, request, "runtime.health", "a".repeat(64)), {
        database: "ready",
        mode: "windows_local",
      });
      assert.deepEqual(
        await repository.execute(grant, randomUUID(), "runtime.version", "a".repeat(64)),
        { protocol: 1, release: "0.2.0-win-dev", schema_head: "0076_remote_assistance.sql" },
      );
      assert.deepEqual(
        await repository.execute(grant, randomUUID(), "maintenance.summary", "a".repeat(64)),
        { window_days: 30, restore_events: 0 },
      );
      await repository.delivered(grant, request);
      await assert.rejects(
        repository.execute(grant, request, "runtime.health", "a".repeat(64)),
        /unique|duplicate/,
      );
      assert.equal((await repository.status(auth, grant.id))?.commands_completed, 3);
      const invisible = await withClient(app, (client) =>
        withTenantTransaction(client, other, (transaction) =>
          transaction.query("SELECT id FROM remote_assistance_sessions WHERE id=$1", [grant.id]),
        ),
      );
      assert.equal(invisible.rows.length, 0);
      await admin.query("UPDATE staffs SET permission_version=permission_version+1 WHERE id=$1", [
        tenant.staffId,
      ]);
      await assert.rejects(repository.verify(grant), /AUTHORITY_INVALID/);
      await admin.query("UPDATE staffs SET permission_version=1 WHERE id=$1", [tenant.staffId]);
      await repository.revoke(auth, grant.id);
      await assert.rejects(repository.verify(grant), /AUTHORITY_INVALID/);
      await assert.rejects(
        withClient(app, (client) =>
          withTenantTransaction(client, tenant, (transaction) =>
            transaction.query(
              "UPDATE remote_assistance_sessions SET status='active',revoked_at=NULL WHERE id=$1",
              [grant.id],
            ),
          ),
        ),
        /revocation is permanent/,
      );
      const audit = await admin.query(
        "SELECT command,after_json FROM audit_log WHERE entity_id=$1 ORDER BY at",
        [grant.id],
      );
      assert.equal(audit.rows.length, 6);
      assert.doesNotMatch(
        JSON.stringify(audit.rows),
        /password|secret|broker_token|SELECT|customer/,
      );
      const restartGrant = {
        ...grant,
        id: randomUUID(),
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3599000,
      };
      await repository.approve(restartGrant);
      assert.equal((await repository.status(auth, null))?.status, "interrupted");
      await assert.rejects(repository.verify(restartGrant), /AUTHORITY_INVALID/);
      assert.equal(
        (
          await admin.query(
            "SELECT command FROM audit_log WHERE entity_id=$1 AND command='remote_assistance.interrupted'",
            [restartGrant.id],
          )
        ).rows.length,
        1,
      );
      const rejected = {
        ...grant,
        id: randomUUID(),
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3599000,
      };
      const trigger = `fail_assistance_${randomUUID().replaceAll("-", "")}`;
      await admin.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command='remote_assistance.authorize' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        await assert.rejects(repository.approve(rejected), /synthetic audit failure/);
      } finally {
        await admin.query(`DROP TRIGGER ${trigger} ON audit_log; DROP FUNCTION ${trigger}()`);
      }
      assert.equal(
        (await admin.query("SELECT id FROM remote_assistance_sessions WHERE id=$1", [rejected.id]))
          .rows.length,
        0,
      );
    } finally {
      await app.end();
      await admin.end();
    }
  },
);
