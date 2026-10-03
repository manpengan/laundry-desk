import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../../db/pg-pool.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { seedMigrationTenant } from "../../data-transfer/import-test-fixture.js";
import { createMemoryLocalRuntime } from "../../local/demo-seed.js";
import type { AuthorizedSession } from "../../auth/session-view.js";
import type { ByokKmsPort } from "../../ai/byok-kms.js";
import {
  createNotificationSettingsService,
  readNotificationSettings,
  notificationCredentials,
} from "./settings-store.js";

const urls = resolvePgUrls(process.env);
// Deliberately reversible fake KMS, confined to synthetic tests; never used by startup.
const kms: ByokKmsPort = {
  wrapDataKey: async ({ plaintextKey }) => ({
    wrappedKey: Buffer.from(plaintextKey),
    keyId: "windows-dpapi-current-user",
    keyVersion: "1",
  }),
  unwrapDataKey: async ({ wrappedKey }) => Buffer.from(wrappedKey),
};

function signal() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Object.freeze({ promise, release });
}

async function waitForPasswordVerification(entered: Promise<void>) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Password verification was not reached")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

test(
  "real PG notification settings reauthenticate, isolate, compare versions and atomically audit sealed credentials",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    const tenant = await seedMigrationTenant(admin);
    const other = await seedMigrationTenant(admin);
    const memory = await createMemoryLocalRuntime();
    const password = "synthetic-notification-password";
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
    await admin.query("UPDATE staffs SET password_hash=$2 WHERE id=$1", [
      tenant.staffId,
      await memory.identity.login.passwordPort.hashPassword(password),
    ]);
    await admin.query(
      `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,
    permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
      [sessionId, tenant.orgId, tenant.storeId, tenant.staffId, deviceId],
    );
    await admin.query(
      "INSERT INTO refresh_families(id,session_id,org_id,store_id,status,created_at) VALUES($1,$2,$3,$4,'active',now())",
      [familyId, sessionId, tenant.orgId, tenant.storeId],
    );
    let reloads = 0;
    const local = Object.freeze({ ...memory, mode: "pg" as const, pool: app });
    const service = createNotificationSettingsService(
      local,
      kms,
      async () => {
        reloads++;
      },
      tenant,
    );
    const input = {
      provider: "aliyun_sms",
      expected_version: 0,
      enabled: false,
      sign_name: "测试洗衣",
      template_code: "SMS_123",
      unit_cost_cents: 5,
      max_batch_cost_cents: 250,
      password,
      credential: { accessKeyId: "SyntheticId123", accessKeySecret: "SyntheticSecret123" },
    };
    try {
      assert.equal((await service.read(auth)).settings, null);
      await assert.rejects(service.save(auth, { ...input, password: "wrong" }), /POLICY_DENIED/u);
      assert.equal(reloads, 0);
      const first = await service.save(auth, input);
      assert.equal(first.settings?.version, 1);
      assert.equal(first.credential_present, true);
      assert.doesNotMatch(JSON.stringify(first), /SyntheticId|SyntheticSecret|envelope/u);
      await assert.rejects(service.save(auth, input), /IDEMPOTENCY_CONFLICT/u);
      const stored = await withClient(app, (client) =>
        withTenantTransaction(client, tenant, (transaction) =>
          readNotificationSettings(transaction, tenant),
        ),
      );
      assert.ok(stored);
      assert.deepEqual(await notificationCredentials(kms, tenant, stored), input.credential);
      const invisible = await withClient(app, (client) =>
        withTenantTransaction(client, other, (transaction) =>
          readNotificationSettings(transaction, tenant),
        ),
      );
      assert.equal(invisible, null);
      await assert.rejects(
        service.read({ ...auth, session: { ...auth.session, org_id: other.orgId } }),
        /POLICY_DENIED/u,
      );
      const audit = await admin.query<{ after_json: string }>(
        "SELECT after_json FROM audit_log WHERE org_id=$1 AND command='notification.provider.configure'",
        [tenant.orgId],
      );
      assert.equal(audit.rows.length, 1);
      assert.doesNotMatch(JSON.stringify(audit.rows), /Synthetic|password|envelope|ciphertext/u);
      // Inject an audit failure only in this runner-owned disposable database.
      await admin.query(`ALTER TABLE audit_log ADD CONSTRAINT notification_fixture_failure
        CHECK (org_id <> '${tenant.orgId}'::uuid) NOT VALID`);
      try {
        await assert.rejects(service.save(auth, { ...input, expected_version: 1 }), {
          code: "23514",
        });
        assert.equal((await service.read(auth)).settings?.version, 1);
        assert.equal(reloads, 1);
      } finally {
        await admin.query("ALTER TABLE audit_log DROP CONSTRAINT notification_fixture_failure");
      }

      const entered = signal();
      const resume = signal();
      const heldService = createNotificationSettingsService(
        {
          ...local,
          identity: {
            ...local.identity,
            login: {
              ...local.identity.login,
              passwordPort: {
                ...local.identity.login.passwordPort,
                verifyPassword: async (value, storedHash) => {
                  entered.release();
                  await resume.promise;
                  return local.identity.login.passwordPort.verifyPassword(value, storedHash);
                },
              },
            },
          },
        },
        kms,
        async () => {
          reloads++;
        },
        tenant,
      );
      const saving = heldService.save(auth, { ...input, expected_version: 1 });
      // Observe early rejection immediately while the other connection attempts revocation.
      const saved = saving.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        await waitForPasswordVerification(entered.promise);
        await withClient(admin, async (revoker) => {
          await revoker.query("BEGIN");
          try {
            await revoker.query("SET LOCAL lock_timeout='250ms'");
            // Change only the role: a staff-only lock would incorrectly let this commit.
            await assert.rejects(
              revoker.query(
                "UPDATE staff_store_roles SET role='staff',is_privacy_admin=false WHERE org_id=$1 AND store_id=$2 AND staff_id=$3",
                [tenant.orgId, tenant.storeId, tenant.staffId],
              ),
              { code: "55P03" },
            );
          } finally {
            await revoker.query("ROLLBACK");
          }
        });
        assert.equal((await service.read(auth)).settings?.version, 1);
        const pendingAudit = await admin.query(
          "SELECT id FROM audit_log WHERE org_id=$1 AND command='notification.provider.configure'",
          [tenant.orgId],
        );
        assert.equal(pendingAudit.rows.length, 1);
        assert.equal(reloads, 1);
      } finally {
        resume.release();
        await saved;
      }
      const completed = await saved;
      assert.equal(completed.error, undefined);
      assert.equal(completed.result?.settings?.version, 2);
      const committedAudit = await admin.query(
        "SELECT id FROM audit_log WHERE org_id=$1 AND command='notification.provider.configure'",
        [tenant.orgId],
      );
      assert.equal(committedAudit.rows.length, 2);
      assert.equal(reloads, 2);
      await admin.query(
        "UPDATE staff_store_roles SET role='staff',is_privacy_admin=false WHERE org_id=$1 AND store_id=$2 AND staff_id=$3",
        [tenant.orgId, tenant.storeId, tenant.staffId],
      );
      await assert.rejects(service.save(auth, { ...input, expected_version: 2 }), /POLICY_DENIED/u);
      await admin.query(
        "UPDATE staff_store_roles SET role='admin',is_privacy_admin=true WHERE org_id=$1 AND store_id=$2 AND staff_id=$3",
        [tenant.orgId, tenant.storeId, tenant.staffId],
      );
      await admin.query("UPDATE sessions SET status='revoked' WHERE id=$1", [sessionId]);
      await assert.rejects(service.save(auth, { ...input, expected_version: 2 }), /POLICY_DENIED/u);
      assert.equal(reloads, 2);
    } finally {
      // Disposable integration runner owns the database; preserve no synthetic rows outside it.
      await Promise.all([app.end(), admin.end()]);
    }
  },
);
