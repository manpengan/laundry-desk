import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { createChannelSettingsService, readChannelSettings, channelAdapter } from "./settings.js";
import { insertIntent } from "./intent-store.js";
import { channelFixture } from "./protocol-fixture.js";
const urls = resolvePgUrls();
const kms: ByokKmsPort = {
  wrapDataKey: async ({ plaintextKey }) => ({
    wrappedKey: Buffer.from(plaintextKey),
    keyId: "windows-dpapi-current-user",
    keyVersion: "1",
  }),
  unwrapDataKey: async ({ wrappedKey }) => Buffer.from(wrappedKey),
};
test(
  "payment credentials require live administrator password and audit atomically without secret copies",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const pool = createPgPool({ connectionString: urls.app });
    const tenant = await seedMigrationTenant(admin);
    const other = await seedMigrationTenant(admin);
    const memory = await createMemoryLocalRuntime();
    const password = "synthetic-channel-password";
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const deviceId = randomUUID();
    const auth: AuthorizedSession = {
      session: {
        session_id: sessionId,
        family_id: familyId,
        org_id: tenant.orgId,
        store_id: tenant.storeId,
        staff_id: tenant.staffId,
        device_id: deviceId,
        session_version: 1,
        permission_version: 1,
        authentication_method: "password",
        status: "active",
        created_at: 1,
        revoked_at: null,
      },
      authority: {
        staff_id: tenant.staffId,
        display_name: "Fixture",
        role: "admin",
        permission_version: 1,
        is_privacy_admin: true,
      },
    };
    try {
      await admin.query("UPDATE staffs SET password_hash=$2 WHERE id=$1", [
        tenant.staffId,
        await memory.identity.login.passwordPort.hashPassword(password),
      ]);
      await admin.query(
        `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
        [sessionId, tenant.orgId, tenant.storeId, tenant.staffId, deviceId],
      );
      await admin.query(
        `INSERT INTO refresh_families(id,session_id,org_id,store_id,status,created_at) VALUES($1,$2,$3,$4,'active',now())`,
        [familyId, sessionId, tenant.orgId, tenant.storeId],
      );
      const local = { ...memory, mode: "pg" as const, pool };
      const service = createChannelSettingsService(local, kms);
      const credential = channelFixture().wechat;
      const input = {
        channel: "wechat",
        expected_version: 0,
        enabled: false,
        password,
        credential,
      };
      await assert.rejects(service.save(auth, { ...input, password: "wrong" }), /POLICY_DENIED/u);
      assert.equal((await service.read(auth)).settings.length, 0);
      const view = await service.save(auth, input);
      assert.equal(view.settings[0]?.version, 1);
      assert.doesNotMatch(JSON.stringify(view), /privateKey|apiV3Key|envelope|password/u);
      await assert.rejects(service.save(auth, input), /IDEMPOTENCY_CONFLICT/u);
      const stored = await withClient(pool, (client) =>
        withTenantTransaction(client, tenant, (tx) => readChannelSettings(tx, tenant, "wechat")),
      );
      assert.ok(stored);
      await channelAdapter(kms, tenant, stored, async () => {
        throw new Error("network forbidden");
      });
      const hidden = await withClient(pool, (client) =>
        withTenantTransaction(client, other, (tx) => readChannelSettings(tx, tenant, "wechat")),
      );
      assert.equal(hidden, null);
      const audit = await admin.query(
        `SELECT after_json FROM audit_log WHERE org_id=$1 AND command='payment.channel.configure'`,
        [tenant.orgId],
      );
      assert.equal(audit.rows.length, 1);
      assert.doesNotMatch(
        JSON.stringify(audit.rows),
        /PRIVATE KEY|privateKey|apiV3Key|password|envelope|synthetic-channel-password/u,
      );
      await admin.query(
        `ALTER TABLE audit_log ADD CONSTRAINT channel_fixture_failure CHECK(org_id<>'${tenant.orgId}'::uuid) NOT VALID`,
      );
      try {
        await assert.rejects(service.save(auth, { ...input, expected_version: 1 }), {
          code: "23514",
        });
        assert.equal((await service.read(auth)).settings[0]?.version, 1);
      } finally {
        await admin.query("ALTER TABLE audit_log DROP CONSTRAINT channel_fixture_failure");
      }
      await service.save(auth, { ...input, expected_version: 1, enabled: true });
      const orderId = randomUUID();
      await admin.query(
        `INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date) VALUES($1::uuid,$2,$3,$1::text,'741852','open',100,100,100,0,100,now(),now(),$4,'2026-10-03')`,
        [orderId, tenant.orgId, tenant.storeId, tenant.staffId],
      );
      await withClient(pool, (client) =>
        withTenantTransaction(client, tenant, (tx) =>
          insertIntent(tx, tenant, {
            idempotencyKey: randomUUID(),
            channel: "wechat",
            purpose: "order",
            orderId,
            accountId: null,
            customerId: null,
          }),
        ),
      );
      await admin.query("DELETE FROM payment_channel_settings WHERE org_id=$1 AND store_id=$2", [
        tenant.orgId,
        tenant.storeId,
      ]);
      await assert.rejects(
        service.save(auth, { ...input, credential: { ...credential, merchantId: "9999999999" } }),
        /RESOURCE_UNAVAILABLE/u,
      );
      assert.equal((await service.read(auth)).settings.length, 0);
      assert.equal((await service.save(auth, input)).settings[0]?.version, 1);
      await admin.query("UPDATE sessions SET status='revoked',revoked_at=now() WHERE id=$1", [
        sessionId,
      ]);
      await assert.rejects(service.save(auth, { ...input, expected_version: 1 }), /POLICY_DENIED/u);
    } finally {
      await pool.end();
      await admin.end();
    }
  },
);
