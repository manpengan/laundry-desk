import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { MiniappLoginInputSchema } from "@laundry/contracts";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { encryptCredential } from "../ai/byok-envelope.js";
import { serializeEnvelope } from "../notification/providers/credential-envelope.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import {
  MINIAPP_TENANT,
  MiniappError,
  readMiniappSettings,
  type MiniappIdentity,
  type MiniappTransaction,
} from "./types.js";
import { miniappCredential } from "./settings.js";
import { createWechatLoginPort, type WechatLoginPort } from "./wechat.js";

const TTL = 15 * 60 * 1000;
export function createMiniappIdentityService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  provider: WechatLoginPort = createWechatLoginPort(),
  now: () => number = Date.now,
) {
  const sessions = new Map<string, MiniappIdentity>();
  const attempts = new Map<string, number>();
  const transaction = async <T>(
    action: (tx: Omit<MiniappTransaction, "identity" | "settings" | "customerId">) => Promise<T>,
  ): Promise<T> => {
    if (local.pool === null || kms === null) throw new MiniappError("RESOURCE_UNAVAILABLE");
    return withPoolClient(local.pool, (client, raw) =>
      withTenantTransaction(client, MINIAPP_TENANT, async () => {
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        return action({ client, raw, tenant: MINIAPP_TENANT });
      }),
    );
  };
  const transact = async <T>(
    token: string,
    action: (tx: MiniappTransaction) => Promise<T>,
  ): Promise<T> => {
    const identity = sessions.get(token);
    if (identity === undefined || identity.expiresAt <= now()) {
      sessions.delete(token);
      throw new MiniappError("AUTHENTICATION_FAILED");
    }
    return transaction(async (tx) => {
      const settings = await readMiniappSettings(tx.client, true);
      if (settings === null || !settings.enabled || settings.version !== identity.configVersion)
        throw new MiniappError("AUTHENTICATION_FAILED");
      await tx.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,42))", [
        tx.tenant.orgId,
      ]);
      const row = (
        await tx.client.query<{ customer_id: string }>(
          `SELECT customer_canonical_root(s.customer_id)::text AS customer_id
        FROM miniapp_sessions s JOIN miniapp_bindings b ON b.org_id=s.org_id AND b.store_id=s.store_id AND b.id=s.binding_id
        JOIN customers c ON c.org_id=s.org_id AND c.id=customer_canonical_root(s.customer_id)
        WHERE s.org_id=$1::uuid AND s.store_id=$2::uuid AND s.id=$3::uuid AND s.binding_id=$4::uuid AND s.customer_id=$5::uuid
        AND s.config_version=$6 AND s.status='active' AND s.expires_at>statement_timestamp() AND b.status='active' AND b.customer_id=s.customer_id
        AND b.app_id=$7 AND c.anonymized_at IS NULL AND c.phone IS NOT NULL FOR SHARE OF s,b,c`,
          [
            tx.tenant.orgId,
            tx.tenant.storeId,
            identity.sessionId,
            identity.bindingId,
            identity.customerId,
            identity.configVersion,
            settings.app_id,
          ],
        )
      ).rows[0];
      if (row === undefined || sessions.get(token) !== identity || identity.expiresAt <= now())
        throw new MiniappError("AUTHENTICATION_FAILED");
      await tx.client.query("SELECT set_config('app.customer_id',$1,true)", [row.customer_id]);
      return action({ ...tx, identity, settings, customerId: row.customer_id });
    });
  };
  return Object.freeze({
    transaction,
    transact,
    clear: () => sessions.clear(),
    async login(raw: unknown) {
      const input = MiniappLoginInputSchema.parse(raw);
      for (const [token, value] of sessions) if (value.expiresAt <= now()) sessions.delete(token);
      for (const [key, expires] of attempts) if (expires <= now()) attempts.delete(key);
      if (sessions.size >= 1000 || attempts.size >= 2000) throw new MiniappError("RATE_LIMITED");
      const digest = createHmac("sha256", local.accessTokenSecret)
        .update(`miniapp-code:${input.code}`)
        .digest("hex");
      if (attempts.has(digest)) throw new MiniappError("AUTHENTICATION_FAILED");
      attempts.set(digest, now() + 5 * 60 * 1000);
      const settings = await transaction(({ client }) => readMiniappSettings(client));
      if (settings === null || !settings.enabled || kms === null)
        throw new MiniappError("RESOURCE_UNAVAILABLE");
      const credential = await miniappCredential(kms, settings);
      const openId = await provider.identity(credential, input.code);
      const openHash = createHmac("sha256", local.accessTokenSecret)
        .update(`miniapp-openid:${settings.app_id}:${openId}`)
        .digest("hex");
      const phone =
        input.phone_code === undefined ? null : await provider.phone(credential, input.phone_code);
      const identity = await transaction(async ({ client, tenant }) => {
        const current = await readMiniappSettings(client, true);
        if (current === null || !current.enabled || current.version !== settings.version)
          throw new MiniappError("AUTHENTICATION_FAILED");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,42))", [tenant.orgId]);
        let binding = (
          await client.query<{ id: string; customer_id: string; status: string }>(
            `SELECT id::text,customer_id::text,status FROM miniapp_bindings
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND app_id=$3 AND openid_sha256=$4 FOR UPDATE`,
            [tenant.orgId, tenant.storeId, settings.app_id, openHash],
          )
        ).rows[0];
        if (binding?.status === "revoked") throw new MiniappError("AUTHENTICATION_FAILED");
        if (binding === undefined) {
          if (phone === null) return null;
          const matches = await client.query<{ id: string }>(
            `SELECT c.id::text FROM customers c WHERE c.org_id=$1::uuid
          AND c.phone=$2 AND c.anonymized_at IS NULL AND c.merged_into_id IS NULL FOR SHARE`,
            [tenant.orgId, phone],
          );
          const customer = matches.rows.length === 1 ? matches.rows[0] : undefined;
          if (customer === undefined) throw new MiniappError("AUTHENTICATION_FAILED");
          binding = { id: randomUUID(), customer_id: customer.id, status: "active" };
          const plaintext = Buffer.from(openId, "utf8");
          let recipientEnvelope: unknown;
          try {
            recipientEnvelope = serializeEnvelope(
              await encryptCredential(
                kms,
                {
                  orgId: tenant.orgId,
                  providerCode: "miniapp_recipient",
                  credentialId: binding.id,
                },
                plaintext,
              ),
            );
          } finally {
            plaintext.fill(0);
          }
          await client.query(
            `INSERT INTO miniapp_bindings(id,org_id,store_id,app_id,openid_sha256,customer_id,encrypted_openid_json) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb)`,
            [
              binding.id,
              tenant.orgId,
              tenant.storeId,
              settings.app_id,
              openHash,
              binding.customer_id,
              recipientEnvelope,
            ],
          );
        }
        const root = await client.query(
          `SELECT 1 FROM customers WHERE org_id=$1::uuid AND id=customer_canonical_root($2::uuid) AND anonymized_at IS NULL AND phone IS NOT NULL FOR SHARE`,
          [tenant.orgId, binding.customer_id],
        );
        if (root.rows.length !== 1) throw new MiniappError("AUTHENTICATION_FAILED");
        const sessionId = randomUUID();
        const expiresAt = now() + TTL;
        await client.query(
          `INSERT INTO miniapp_sessions(id,org_id,store_id,binding_id,customer_id,config_version,created_at,expires_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8)`,
          [
            sessionId,
            tenant.orgId,
            tenant.storeId,
            binding.id,
            binding.customer_id,
            settings.version,
            new Date(expiresAt - TTL),
            new Date(expiresAt),
          ],
        );
        return Object.freeze({
          sessionId,
          bindingId: binding.id,
          customerId: binding.customer_id,
          configVersion: settings.version,
          openId,
          expiresAt,
        });
      });
      if (identity === null) return Object.freeze({ binding_required: true as const });
      if (sessions.size >= 1000) throw new MiniappError("RATE_LIMITED");
      const token = `m1.${randomBytes(32).toString("base64url")}`;
      sessions.set(token, identity);
      return Object.freeze({
        authenticated: true as const,
        access_token: token,
        expires_at: Math.floor(identity.expiresAt / 1000),
      });
    },
    async logout(token: string) {
      const identity = sessions.get(token);
      sessions.delete(token);
      if (identity !== undefined)
        await transaction(({ client, tenant }) =>
          client.query(
            `UPDATE miniapp_sessions SET status='revoked',revoked_at=statement_timestamp() WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'`,
            [tenant.orgId, tenant.storeId, identity.sessionId],
          ),
        );
      return Object.freeze({ logged_out: true as const });
    },
  });
}
export type MiniappIdentityService = ReturnType<typeof createMiniappIdentityService>;
