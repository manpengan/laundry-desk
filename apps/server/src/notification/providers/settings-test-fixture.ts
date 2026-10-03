import { randomUUID } from "node:crypto";
import type { PgPool } from "../../db/pg-pool.js";
import type { TenantContext } from "../../db/types.js";
import type { AuthorizedSession } from "../../auth/session-view.js";
import type { ByokKmsPort } from "../../ai/byok-kms.js";
import { createMemoryLocalRuntime } from "../../local/demo-seed.js";
import { createNotificationSettingsService } from "./settings-store.js";

/** Synthetic test fixture; production always constructs the native Windows KMS. */
export async function settingsFixture(admin: PgPool, app: PgPool, tenant: TenantContext) {
  const base = await createMemoryLocalRuntime();
  const password = "synthetic-settings-fixture-password";
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const deviceId = randomUUID();
  await admin.query("UPDATE staffs SET password_hash=$2 WHERE id=$1", [
    tenant.staffId,
    await base.identity.login.passwordPort.hashPassword(password),
  ]);
  await admin.query(
    `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,
    permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
    [sessionId, tenant.orgId, tenant.storeId, tenant.staffId, deviceId],
  );
  await admin.query(
    `INSERT INTO refresh_families(id,session_id,org_id,store_id,status,created_at)
    VALUES($1,$2,$3,$4,'active',now())`,
    [familyId, sessionId, tenant.orgId, tenant.storeId],
  );
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
  const kms: ByokKmsPort = {
    wrapDataKey: async ({ plaintextKey }) => ({
      wrappedKey: Buffer.from(plaintextKey),
      keyId: "windows-dpapi-current-user",
      keyVersion: "1",
    }),
    unwrapDataKey: async ({ wrappedKey }) => Buffer.from(wrappedKey),
  };
  const service = createNotificationSettingsService(
    { ...base, mode: "pg", pool: app },
    kms,
    async () => undefined,
    tenant,
  );
  return { service, auth, password };
}
