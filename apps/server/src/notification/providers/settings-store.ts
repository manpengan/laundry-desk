import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NotificationProviderSettingsSchema,
  NotificationProviderSettingsRequestSchema,
  type NotificationProviderSettings,
  type NotificationProviderSettingsView,
} from "@laundry/contracts";
import type { AuthorizedSession } from "../../auth/session-view.js";
import type { ByokKmsPort } from "../../ai/byok-kms.js";
import { encryptCredential, decryptCredential } from "../../ai/byok-envelope.js";
import { createByokRuntime } from "../../ai/byok-runtime.js";
import { requesterAuthorityIsCurrent } from "../../ai/byok-requester-authority.js";
import type { LocalRuntime } from "../../local/runtime-types.js";
import type { SqlClient, TenantContext } from "../../db/types.js";
import { parseEnvelope, serializeEnvelope } from "./credential-envelope.js";

type SettingsRow = NotificationProviderSettings &
  Readonly<{
    credential_id: string;
    envelope_json: unknown;
  }>;
const Credential = z.strictObject({
  accessKeyId: z.string().regex(/^[A-Za-z0-9]{8,128}$/u),
  accessKeySecret: z.string().regex(/^[\x21-\x7e]{8,256}$/u),
});
export class NotificationSettingsError extends Error {
  constructor(readonly code: "POLICY_DENIED" | "RESOURCE_UNAVAILABLE" | "IDEMPOTENCY_CONFLICT") {
    super(code);
    this.name = "NotificationSettingsError";
  }
}
export const notificationTenant = (auth: AuthorizedSession): TenantContext =>
  Object.freeze({
    orgId: auth.session.org_id,
    storeId: auth.session.store_id,
    staffId: auth.session.staff_id,
  });
export async function readNotificationSettings(client: SqlClient, tenant: TenantContext) {
  const row = (
    await client.query<SettingsRow>(
      `SELECT version,enabled,provider,sign_name,template_code,unit_cost_cents,
      max_batch_cost_cents,credential_id,envelope_json
     FROM notification_provider_settings WHERE org_id=$1::uuid AND store_id=$2::uuid`,
      [tenant.orgId, tenant.storeId],
    )
  ).rows[0];
  if (row === undefined) return null;
  const { credential_id, envelope_json, ...fields } = row;
  return Object.freeze({
    settings: NotificationProviderSettingsSchema.parse(fields),
    credentialId: z.uuid().parse(credential_id),
    envelope: parseEnvelope(envelope_json),
  });
}
export type StoredNotificationSettings = NonNullable<
  Awaited<ReturnType<typeof readNotificationSettings>>
>;

export async function notificationCredentials(
  kms: ByokKmsPort,
  tenant: TenantContext,
  stored: StoredNotificationSettings,
) {
  const bytes = await decryptCredential(
    kms,
    {
      orgId: tenant.orgId,
      providerCode: "aliyun_sms",
      credentialId: stored.credentialId,
    },
    stored.envelope,
  );
  try {
    return Credential.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  } finally {
    bytes.fill(0);
  }
}

export function createNotificationSettingsService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  onSaved: () => Promise<void>,
  scope: Readonly<{ orgId: string; storeId: string }>,
) {
  const runtime = createByokRuntime(local, kms);
  const requireScope = (auth: AuthorizedSession) => {
    if (auth.session.org_id !== scope.orgId || auth.session.store_id !== scope.storeId)
      throw new NotificationSettingsError("POLICY_DENIED");
  };
  const read = async (auth: AuthorizedSession): Promise<NotificationProviderSettingsView> => {
    requireScope(auth);
    const stored = await runtime.transact(notificationTenant(auth), ({ client, tenant }) =>
      readNotificationSettings(client, tenant),
    );
    return Object.freeze({
      settings: stored?.settings ?? null,
      custody_available: kms !== null && local.pool !== null,
      credential_present: stored !== null,
    });
  };
  return Object.freeze({
    read,
    async save(auth: AuthorizedSession, raw: unknown) {
      requireScope(auth);
      const input = NotificationProviderSettingsRequestSchema.parse(raw);
      if (kms === null || local.pool === null)
        throw new NotificationSettingsError("RESOURCE_UNAVAILABLE");
      await runtime.transact(notificationTenant(auth), async (transaction) => {
        const { client, tenant } = transaction;
        if (!(await requesterAuthorityIsCurrent(runtime, auth, transaction)))
          throw new NotificationSettingsError("POLICY_DENIED");
        const password = await client.query<{ password_hash: string }>(
          `SELECT staff.password_hash FROM staffs staff
           JOIN staff_store_roles role ON role.org_id=staff.org_id AND role.staff_id=staff.id
           WHERE staff.org_id=$1::uuid AND staff.id=$2::uuid AND staff.is_active
             AND staff.permission_version=$3 AND role.store_id=$4::uuid
             AND role.is_active AND role.role='admin'
           FOR SHARE OF staff,role`,
          [tenant.orgId, tenant.staffId, auth.session.permission_version, tenant.storeId],
        );
        if (
          password.rows[0] === undefined ||
          !(await local.identity.login.passwordPort.verifyPassword(
            input.password,
            password.rows[0].password_hash,
          ))
        )
          throw new NotificationSettingsError("POLICY_DENIED");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 77))", [
          `${tenant.orgId}:${tenant.storeId}:notification-settings`,
        ]);
        const previous = await readNotificationSettings(client, tenant);
        if ((previous?.settings.version ?? 0) !== input.expected_version)
          throw new NotificationSettingsError("IDEMPOTENCY_CONFLICT");
        const pending = await client.query<{ pending: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM notification_deliveries
            WHERE org_id=$1::uuid AND store_id=$2::uuid
            AND (status IN ('queued','sending','retry_wait','accepted') OR reserved_cost_cents>0)) AS pending`,
          [tenant.orgId, tenant.storeId],
        );
        const sameDeliveryConfig =
          previous !== null &&
          input.sign_name === previous.settings.sign_name &&
          input.template_code === previous.settings.template_code &&
          input.unit_cost_cents === previous.settings.unit_cost_cents &&
          input.max_batch_cost_cents === previous.settings.max_batch_cost_cents;
        if (pending.rows[0]?.pending === true && !sameDeliveryConfig)
          throw new NotificationSettingsError("RESOURCE_UNAVAILABLE");
        const credentialId = input.credential === undefined ? previous?.credentialId : randomUUID();
        if (credentialId === undefined) throw new NotificationSettingsError("RESOURCE_UNAVAILABLE");
        const envelope =
          input.credential === undefined
            ? previous?.envelope
            : await encryptCredential(
                kms,
                { orgId: tenant.orgId, providerCode: "aliyun_sms", credentialId },
                Buffer.from(JSON.stringify(input.credential), "utf8"),
              );
        if (envelope === undefined) throw new NotificationSettingsError("RESOURCE_UNAVAILABLE");
        const settings = NotificationProviderSettingsSchema.parse({
          version: input.expected_version + 1,
          enabled: input.enabled,
          provider: input.provider,
          sign_name: input.sign_name,
          template_code: input.template_code,
          unit_cost_cents: input.unit_cost_cents,
          max_batch_cost_cents: input.max_batch_cost_cents,
        });
        await client.query(
          `INSERT INTO notification_provider_settings(org_id,store_id,version,enabled,provider,
            sign_name,template_code,unit_cost_cents,max_batch_cost_cents,credential_id,envelope_json,updated_by)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::uuid,$11::jsonb,$12::uuid)
           ON CONFLICT(org_id,store_id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,
            sign_name=EXCLUDED.sign_name,template_code=EXCLUDED.template_code,unit_cost_cents=EXCLUDED.unit_cost_cents,
            max_batch_cost_cents=EXCLUDED.max_batch_cost_cents,credential_id=EXCLUDED.credential_id,
            envelope_json=EXCLUDED.envelope_json,updated_by=EXCLUDED.updated_by,updated_at=statement_timestamp()`,
          [
            tenant.orgId,
            tenant.storeId,
            settings.version,
            settings.enabled,
            settings.provider,
            settings.sign_name,
            settings.template_code,
            settings.unit_cost_cents,
            settings.max_batch_cost_cents,
            credentialId,
            serializeEnvelope(envelope),
            tenant.staffId,
          ],
        );
        await client.query(
          `INSERT INTO audit_log(id,org_id,store_id,staff_id,via,command,idempotency_key,dry_run,
            entity,entity_id,before_json,after_json,ip,device_id,at)
           VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ui','notification.provider.configure',NULL,false,
            'notification_provider_settings',$3::uuid::text,$5,$6,NULL,$7::uuid,statement_timestamp())`,
          [
            randomUUID(),
            tenant.orgId,
            tenant.storeId,
            tenant.staffId,
            previous === null ? null : JSON.stringify(previous.settings),
            JSON.stringify({ ...settings, credential_replaced: input.credential !== undefined }),
            auth.session.device_id,
          ],
        );
      });
      await onSaved();
      return read(auth);
    },
  });
}
