import { randomUUID } from "node:crypto";
import { MiniappSettingsSaveSchema, MiniappSettingsViewSchema } from "@laundry/contracts";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { encryptCredential, decryptCredential } from "../ai/byok-envelope.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import { requesterAuthorityIsCurrent } from "../ai/byok-requester-authority.js";
import { parseEnvelope, serializeEnvelope } from "../notification/providers/credential-envelope.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import {
  MINIAPP_TENANT,
  MiniappError,
  readMiniappSettings,
  type MiniappSettingsRow,
} from "./types.js";

export async function miniappCredential(kms: ByokKmsPort, settings: MiniappSettingsRow) {
  const bytes = await decryptCredential(
    kms,
    {
      orgId: MINIAPP_TENANT.orgId,
      providerCode: "miniapp_wechat",
      credentialId: settings.credential_id,
    },
    parseEnvelope(settings.envelope_json),
  );
  try {
    return Object.freeze({ appId: settings.app_id, secret: bytes.toString("utf8") });
  } finally {
    bytes.fill(0);
  }
}
export function createMiniappSettingsService(local: LocalRuntime, kms: ByokKmsPort | null) {
  const runtime = createByokRuntime(local, kms);
  const read = async () =>
    runtime.transact(MINIAPP_TENANT, async ({ client }) => {
      const row = local.pool === null ? null : await readMiniappSettings(client);
      const staff =
        local.pool === null
          ? []
          : (
              await client.query<{ staff_id: string; display_name: string }>(
                `SELECT s.id::text AS staff_id,s.display_name FROM staffs s
        JOIN staff_store_roles r ON r.org_id=s.org_id AND r.staff_id=s.id WHERE s.org_id=$1::uuid AND r.store_id=$2::uuid AND s.is_active AND r.is_active
        AND r.role IN('admin','staff') ORDER BY s.display_name,s.id LIMIT 100`,
                [MINIAPP_TENANT.orgId, MINIAPP_TENANT.storeId],
              )
            ).rows;
      return MiniappSettingsViewSchema.parse({
        custody_available: local.pool !== null && kms !== null,
        version: row?.version ?? 0,
        enabled: row?.enabled ?? false,
        transactions_enabled: row?.transactions_enabled ?? false,
        delegated_staff_id: row?.delegated_staff_id ?? null,
        app_id: row?.app_id ?? null,
        eligible_staff: staff,
        credential_present: row !== null,
        subscription_template_ids: row?.subscription_template_ids ?? [],
      });
    });
  return Object.freeze({
    read,
    async save(auth: AuthorizedSession, raw: unknown) {
      const input = MiniappSettingsSaveSchema.parse(raw);
      if (kms === null || local.pool === null) throw new MiniappError("RESOURCE_UNAVAILABLE");
      if (
        auth.session.org_id !== MINIAPP_TENANT.orgId ||
        auth.session.store_id !== MINIAPP_TENANT.storeId
      )
        throw new MiniappError("POLICY_DENIED");
      await runtime.transact(
        { ...MINIAPP_TENANT, staffId: auth.session.staff_id },
        async (transaction) => {
          const { client, tenant } = transaction;
          if (!(await requesterAuthorityIsCurrent(runtime, auth, transaction)))
            throw new MiniappError("POLICY_DENIED");
          const actor = (
            await client.query<{ password_hash: string }>(
              `SELECT s.password_hash FROM staffs s JOIN staff_store_roles r ON r.org_id=s.org_id AND r.staff_id=s.id
        WHERE s.org_id=$1::uuid AND s.id=$2::uuid AND s.is_active AND s.permission_version=$3 AND r.store_id=$4::uuid AND r.is_active AND r.role='admin' FOR SHARE OF s,r`,
              [tenant.orgId, tenant.staffId, auth.session.permission_version, tenant.storeId],
            )
          ).rows[0];
          if (
            actor === undefined ||
            !(await local.identity.login.passwordPort.verifyPassword(
              input.password,
              actor.password_hash,
            ))
          )
            throw new MiniappError("POLICY_DENIED");
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,87))", [
            `${tenant.orgId}:${tenant.storeId}`,
          ]);
          const previous = await readMiniappSettings(client);
          if ((previous?.version ?? 0) !== input.expected_version)
            throw new MiniappError("IDEMPOTENCY_CONFLICT");
          if (previous !== null && previous.app_id !== input.app_id)
            throw new MiniappError("POLICY_DENIED");
          if (input.delegated_staff_id !== null) {
            const delegate = await client.query(
              `SELECT 1 FROM staffs s JOIN staff_store_roles r ON r.org_id=s.org_id AND r.staff_id=s.id WHERE s.org_id=$1::uuid AND s.id=$2::uuid
          AND s.is_active AND r.store_id=$3::uuid AND r.is_active AND r.role IN ('admin','staff') FOR SHARE OF s,r`,
              [tenant.orgId, input.delegated_staff_id, tenant.storeId],
            );
            if (delegate.rows.length !== 1) throw new MiniappError("POLICY_DENIED");
          }
          if (previous === null && input.app_secret === undefined)
            throw new MiniappError("VALIDATION_FAILED");
          const credentialId =
            input.app_secret === undefined ? previous?.credential_id : randomUUID();
          const bytes =
            input.app_secret === undefined ? null : Buffer.from(input.app_secret, "utf8");
          let envelope = previous?.envelope_json;
          try {
            if (bytes !== null && credentialId !== undefined)
              envelope = serializeEnvelope(
                await encryptCredential(
                  kms,
                  { orgId: tenant.orgId, providerCode: "miniapp_wechat", credentialId },
                  bytes,
                ),
              );
          } finally {
            bytes?.fill(0);
          }
          await client.query(
            `INSERT INTO miniapp_settings(org_id,store_id,version,enabled,transactions_enabled,delegated_staff_id,app_id,credential_id,envelope_json,subscription_template_ids,updated_by)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8::uuid,$9::jsonb,$10::jsonb,$11::uuid) ON CONFLICT(org_id,store_id) DO UPDATE SET
        version=EXCLUDED.version,enabled=EXCLUDED.enabled,transactions_enabled=EXCLUDED.transactions_enabled,delegated_staff_id=EXCLUDED.delegated_staff_id,
        credential_id=EXCLUDED.credential_id,envelope_json=EXCLUDED.envelope_json,subscription_template_ids=EXCLUDED.subscription_template_ids,updated_by=EXCLUDED.updated_by,updated_at=statement_timestamp()`,
            [
              tenant.orgId,
              tenant.storeId,
              input.expected_version + 1,
              input.enabled,
              input.transactions_enabled,
              input.delegated_staff_id,
              input.app_id,
              credentialId,
              envelope,
              JSON.stringify(input.subscription_template_ids),
              tenant.staffId,
            ],
          );
          await client.query(
            `UPDATE miniapp_sessions SET status='revoked',revoked_at=statement_timestamp() WHERE org_id=$1::uuid AND store_id=$2::uuid AND status='active'`,
            [tenant.orgId, tenant.storeId],
          );
          await client.query(
            `INSERT INTO audit_log(id,org_id,store_id,staff_id,via,command,dry_run,entity,entity_id,after_json,at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ui','miniapp.configure',false,'miniapp_settings',$5,$6,statement_timestamp())`,
            [
              randomUUID(),
              tenant.orgId,
              tenant.storeId,
              tenant.staffId,
              tenant.storeId,
              JSON.stringify({
                version: input.expected_version + 1,
                enabled: input.enabled,
                transactions_enabled: input.transactions_enabled,
                delegated_staff_id: input.delegated_staff_id,
                credential_replaced: bytes !== null,
              }),
            ],
          );
        },
      );
      return read();
    },
  });
}
