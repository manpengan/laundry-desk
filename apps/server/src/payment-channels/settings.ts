import { createHash, randomUUID } from "node:crypto";
import {
  PaymentChannelSettingsRequestSchema,
  PaymentChannelSettingsViewSchema,
} from "@laundry/contracts";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { encryptCredential, decryptCredential } from "../ai/byok-envelope.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import { requesterAuthorityIsCurrent } from "../ai/byok-requester-authority.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { parseEnvelope, serializeEnvelope } from "../notification/providers/credential-envelope.js";
import { createWechatAdapter } from "./wechat.js";
import { createAlipayAdapter } from "./alipay.js";
import {
  ChannelCredentialSchema,
  type ChannelCredential,
  type ChannelHttp,
  type PaymentChannel,
} from "./types.js";

export class ChannelBusinessError extends Error {
  constructor(
    readonly code:
      "POLICY_DENIED" | "RESOURCE_UNAVAILABLE" | "IDEMPOTENCY_CONFLICT" | "VALIDATION_FAILED",
  ) {
    super(code);
    this.name = "ChannelBusinessError";
  }
}
export const channelTenant = (auth: AuthorizedSession): TenantContext =>
  Object.freeze({
    orgId: auth.session.org_id,
    storeId: auth.session.store_id,
    staffId: auth.session.staff_id,
  });
export type ChannelSettingsRow = Readonly<{
  channel: PaymentChannel;
  version: number;
  enabled: boolean;
  app_id: string;
  merchant_id: string;
  account_fingerprint: string;
  credential_id: string;
  envelope_json: unknown;
}>;
export async function readChannelSettings(
  client: SqlClient,
  tenant: TenantContext,
  channel: PaymentChannel,
  lock = false,
) {
  return (
    (
      await client.query<ChannelSettingsRow>(
        `SELECT channel,version,enabled,app_id,merchant_id,
    account_fingerprint,credential_id::text,envelope_json FROM payment_channel_settings
    WHERE org_id=$1::uuid AND store_id=$2::uuid AND channel=$3${lock ? " FOR SHARE" : ""}`,
        [tenant.orgId, tenant.storeId, channel],
      )
    ).rows[0] ?? null
  );
}
export function accountFingerprint(credential: ChannelCredential) {
  const merchant = credential.channel === "wechat" ? credential.merchantId : credential.sellerId;
  return createHash("sha256")
    .update(`${credential.channel}\n${credential.appId}\n${merchant}`)
    .digest("hex");
}
export async function channelAdapter(
  kms: ByokKmsPort,
  tenant: TenantContext,
  stored: ChannelSettingsRow,
  http?: ChannelHttp,
) {
  const bytes = await decryptCredential(
    kms,
    {
      orgId: tenant.orgId,
      providerCode: `payment_${stored.channel}`,
      credentialId: stored.credential_id,
    },
    parseEnvelope(stored.envelope_json),
  );
  try {
    const credential = ChannelCredentialSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (
      credential.channel !== stored.channel ||
      accountFingerprint(credential) !== stored.account_fingerprint
    )
      throw new ChannelBusinessError("POLICY_DENIED");
    return credential.channel === "wechat"
      ? createWechatAdapter(credential, http)
      : createAlipayAdapter(credential, http);
  } finally {
    bytes.fill(0);
  }
}

export function createChannelSettingsService(local: LocalRuntime, kms: ByokKmsPort | null) {
  const runtime = createByokRuntime(local, kms);
  const read = async (auth: AuthorizedSession) =>
    runtime.transact(channelTenant(auth), async ({ client, tenant }) => {
      const rows = await client.query<ChannelSettingsRow>(
        `SELECT channel,version,enabled,app_id,merchant_id
      FROM payment_channel_settings WHERE org_id=$1::uuid AND store_id=$2::uuid ORDER BY channel`,
        [tenant.orgId, tenant.storeId],
      );
      return PaymentChannelSettingsViewSchema.parse({
        custody_available: local.pool !== null && kms !== null,
        settings: rows.rows.map(({ channel, version, enabled, app_id, merchant_id }) => ({
          channel,
          version,
          enabled,
          app_id,
          merchant_id,
          credential_present: true,
        })),
      });
    });
  return Object.freeze({
    read,
    async save(auth: AuthorizedSession, raw: unknown) {
      const input = PaymentChannelSettingsRequestSchema.parse(raw);
      if (kms === null || local.pool === null)
        throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      await runtime.transact(channelTenant(auth), async (transaction) => {
        const { client, tenant } = transaction;
        if (!(await requesterAuthorityIsCurrent(runtime, auth, transaction)))
          throw new ChannelBusinessError("POLICY_DENIED");
        const actor = (
          await client.query<{ password_hash: string }>(
            `SELECT staff.password_hash FROM staffs staff
        JOIN staff_store_roles role ON role.org_id=staff.org_id AND role.staff_id=staff.id
        WHERE staff.org_id=$1::uuid AND staff.id=$2::uuid AND staff.is_active AND staff.permission_version=$3
        AND role.store_id=$4::uuid AND role.is_active AND role.role='admin' FOR SHARE OF staff,role`,
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
          throw new ChannelBusinessError("POLICY_DENIED");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,85))", [
          `${tenant.orgId}:${tenant.storeId}:${input.channel}`,
        ]);
        const previous = await readChannelSettings(client, tenant, input.channel);
        if ((previous?.version ?? 0) !== input.expected_version)
          throw new ChannelBusinessError("IDEMPOTENCY_CONFLICT");
        const credential = input.credential;
        if (credential !== undefined) {
          if (Buffer.byteLength(JSON.stringify(credential), "utf8") > 8192)
            throw new ChannelBusinessError("VALIDATION_FAILED");
          if (credential.channel === "wechat") createWechatAdapter(credential);
          else createAlipayAdapter(credential);
        }
        const fingerprint =
          credential === undefined ? previous?.account_fingerprint : accountFingerprint(credential);
        if (fingerprint === undefined) throw new ChannelBusinessError("VALIDATION_FAILED");
        const historical = await client.query(
          `SELECT 1 FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid
          AND channel=$3 AND account_fingerprint<>$4 LIMIT 1`,
          [tenant.orgId, tenant.storeId, input.channel, fingerprint],
        );
        // This also binds first configuration after restore, when the encrypted
        // settings row was deliberately omitted but historical receipts remain.
        if (historical.rows.length > 0) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
        const credentialId = credential === undefined ? previous?.credential_id : randomUUID();
        if (credentialId === undefined) throw new ChannelBusinessError("VALIDATION_FAILED");
        const plain =
          credential === undefined ? null : Buffer.from(JSON.stringify(credential), "utf8");
        let envelope: unknown;
        try {
          envelope =
            plain === null
              ? previous?.envelope_json
              : serializeEnvelope(
                  await encryptCredential(
                    kms,
                    { orgId: tenant.orgId, providerCode: `payment_${input.channel}`, credentialId },
                    plain,
                  ),
                );
        } finally {
          plain?.fill(0);
        }
        const appId = credential?.appId ?? previous?.app_id;
        const merchantId =
          credential === undefined
            ? previous?.merchant_id
            : credential.channel === "wechat"
              ? credential.merchantId
              : credential.sellerId;
        await client.query(
          `INSERT INTO payment_channel_settings(org_id,store_id,channel,version,enabled,app_id,merchant_id,
        account_fingerprint,credential_id,envelope_json,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::uuid,$10::jsonb,$11::uuid)
        ON CONFLICT(org_id,store_id,channel) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,app_id=EXCLUDED.app_id,
        merchant_id=EXCLUDED.merchant_id,account_fingerprint=EXCLUDED.account_fingerprint,credential_id=EXCLUDED.credential_id,
        envelope_json=EXCLUDED.envelope_json,updated_by=EXCLUDED.updated_by,updated_at=statement_timestamp()`,
          [
            tenant.orgId,
            tenant.storeId,
            input.channel,
            input.expected_version + 1,
            input.enabled,
            appId,
            merchantId,
            fingerprint,
            credentialId,
            envelope,
            tenant.staffId,
          ],
        );
        await client.query(
          `INSERT INTO audit_log(id,org_id,store_id,staff_id,via,command,dry_run,entity,entity_id,after_json,device_id,at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ui','payment.channel.configure',false,'payment_channel_settings',$5,$6,$7::uuid,statement_timestamp())`,
          [
            randomUUID(),
            tenant.orgId,
            tenant.storeId,
            tenant.staffId,
            input.channel,
            JSON.stringify({
              channel: input.channel,
              version: input.expected_version + 1,
              enabled: input.enabled,
              credential_replaced: credential !== undefined,
            }),
            auth.session.device_id,
          ],
        );
      });
      return read(auth);
    },
  });
}
