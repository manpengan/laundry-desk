import { randomUUID } from "node:crypto";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import { decryptCredential } from "../ai/byok-envelope.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { parseEnvelope } from "../notification/providers/credential-envelope.js";
import { miniappCredential } from "./settings.js";
import { readMiniappSettings, MiniappError } from "./types.js";
import {
  notificationOrder,
  readNotificationConfig,
  requireNotificationTenant,
} from "./notifications-store.js";
import {
  createWechatNotificationPort,
  type WechatNotificationPort,
} from "./notifications-provider.js";
export type NotificationOutbox = Readonly<{
  id: string;
  order_id: string;
  customer_id: string;
  binding_id: string;
  consent_id: string;
  created_by: string;
  settings_version: number;
  miniapp_version: number;
  template_id: string;
  payload_json: unknown;
  state: string;
  dispatched_at: Date | null;
}>;
async function read(client: SqlClient, tenant: TenantContext, id: string) {
  return (
    await client.query<NotificationOutbox>(
      `SELECT id::text,order_id::text,customer_id::text,binding_id::text,consent_id::text,created_by::text,settings_version,miniapp_version,template_id,payload_json,state,dispatched_at FROM miniapp_notification_outbox WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE`,
      [tenant.orgId, tenant.storeId, id],
    )
  ).rows[0];
}
async function audit(
  client: SqlClient,
  tenant: TenantContext,
  row: NotificationOutbox,
  state: string,
  errorCode: string | null,
) {
  await client.query(
    `INSERT INTO audit_log(id,org_id,store_id,staff_id,via,command,dry_run,entity,entity_id,after_json,at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ui','notification.wechat.dispatch',false,'miniapp_notification_outbox',$5,$6,statement_timestamp())`,
    [
      randomUUID(),
      tenant.orgId,
      tenant.storeId,
      row.created_by,
      row.id,
      JSON.stringify({ state, error_code: errorCode }),
    ],
  );
}
async function liveDispatch(client: SqlClient, tenant: TenantContext, row: NotificationOutbox) {
  const app = await readMiniappSettings(client, true);
  const config = await readNotificationConfig(client, tenant, true);
  if (
    app === null ||
    !app.enabled ||
    app.version !== row.miniapp_version ||
    config === null ||
    !config.enabled ||
    config.version !== row.settings_version ||
    config.template_id !== row.template_id ||
    !app.subscription_template_ids.includes(row.template_id)
  )
    throw new MiniappError("POLICY_DENIED");
  const order = await notificationOrder(client, tenant, row.order_id, true);
  if (order.customer_id !== row.customer_id) throw new MiniappError("POLICY_DENIED");
  const staff = (
    await client.query<{ role: "admin" | "staff"; is_privacy_admin: boolean }>(
      `SELECT r.role,r.is_privacy_admin FROM staffs s JOIN staff_store_roles r ON r.org_id=s.org_id AND r.staff_id=s.id WHERE s.org_id=$1::uuid AND s.id=$2::uuid AND s.is_active AND r.store_id=$3::uuid AND r.is_active FOR SHARE OF s,r`,
      [tenant.orgId, row.created_by, tenant.storeId],
    )
  ).rows[0];
  if (staff === undefined || !permissionsForAuthority(staff).includes("notification_send"))
    throw new MiniappError("PERMISSION_DENIED");
  const binding = (
    await client.query<{ encrypted_openid_json: unknown }>(
      `SELECT b.encrypted_openid_json FROM miniapp_bindings b JOIN miniapp_sessions s ON s.org_id=b.org_id AND s.store_id=b.store_id AND s.binding_id=b.id JOIN miniapp_subscriptions c ON c.org_id=s.org_id AND c.store_id=s.store_id AND c.session_id=s.id WHERE b.org_id=$1::uuid AND b.store_id=$2::uuid AND b.id=$3::uuid AND b.customer_id=$4::uuid AND b.status='active' AND b.app_id=$5 AND s.status='active' AND s.customer_id=b.customer_id AND c.id=$6::uuid AND c.outbox_id=$7::uuid AND c.consumed_at IS NOT NULL AND c.revoked_at IS NULL FOR SHARE OF b,s,c`,
      [
        tenant.orgId,
        tenant.storeId,
        row.binding_id,
        row.customer_id,
        app.app_id,
        row.consent_id,
        row.id,
      ],
    )
  ).rows[0];
  if (binding === undefined) throw new MiniappError("POLICY_DENIED");
  return { app, config: { ...config, available: true }, binding };
}
export function createWechatNotificationDispatcher(
  local: LocalRuntime,
  kms: ByokKmsPort,
  provider: WechatNotificationPort = createWechatNotificationPort(),
) {
  const { transact } = createByokRuntime(local, kms);
  return Object.freeze({
    transact,
    async advance(tenant: TenantContext, id: string) {
      requireNotificationTenant(tenant);
      const prepared = await transact(tenant, async ({ client }) => {
        const row = await read(client, tenant, id);
        if (row === undefined || row.state !== "queued" || row.dispatched_at !== null) return null;
        await client.query(
          `UPDATE miniapp_notification_outbox SET checked_at=statement_timestamp() WHERE id=$1::uuid`,
          [id],
        );
        try {
          return { row, ...(await liveDispatch(client, tenant, row)) };
        } catch (error) {
          if (!(error instanceof MiniappError)) throw error;
          await client.query(
            `UPDATE miniapp_notification_outbox SET state='cancelled',error_code='WECHAT_AUTHORITY_CHANGED' WHERE id=$1::uuid`,
            [id],
          );
          await audit(client, tenant, row, "cancelled", "WECHAT_AUTHORITY_CHANGED");
          return null;
        }
      });
      if (prepared === null) return;
      // Token acquisition has no user-facing side effect. Failure keeps the job queued.
      const token = await provider.token(await miniappCredential(kms, prepared.app));
      const claimed = await transact(tenant, async ({ client }) => {
        const row = await read(client, tenant, id);
        if (row === undefined || row.state !== "queued" || row.dispatched_at !== null) return null;
        let live;
        try {
          live = await liveDispatch(client, tenant, row);
        } catch (error) {
          if (!(error instanceof MiniappError)) throw error;
          await client.query(
            `UPDATE miniapp_notification_outbox SET state='cancelled',error_code='WECHAT_AUTHORITY_CHANGED' WHERE id=$1::uuid`,
            [id],
          );
          await audit(client, tenant, row, "cancelled", "WECHAT_AUTHORITY_CHANGED");
          return null;
        }
        const bytes = await decryptCredential(
          kms,
          { orgId: tenant.orgId, providerCode: "miniapp_recipient", credentialId: row.binding_id },
          parseEnvelope(live.binding.encrypted_openid_json),
        );
        let openId: string;
        try {
          openId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } finally {
          bytes.fill(0);
        }
        await client.query(
          `UPDATE miniapp_notification_outbox SET state='sending',dispatched_at=statement_timestamp(),checked_at=statement_timestamp(),error_code=NULL WHERE id=$1::uuid`,
          [id],
        );
        await audit(client, tenant, row, "sending", null);
        return { row, openId, config: live.config };
      });
      if (claimed === null) return;
      const receipt = await provider.send(
        token,
        claimed.openId,
        claimed.config,
        claimed.row.payload_json,
      );
      await transact(tenant, async ({ client }) => {
        const row = await read(client, tenant, id);
        if (row === undefined || row.state !== "sending") return;
        await client.query(
          `UPDATE miniapp_notification_outbox SET state=$2,error_code=$3,checked_at=statement_timestamp() WHERE id=$1::uuid`,
          [id, receipt.state, receipt.errorCode],
        );
        await audit(client, tenant, row, receipt.state, receipt.errorCode);
      });
    },
    async due(tenant: TenantContext) {
      return transact(tenant, async ({ client }) => {
        const stranded = await client.query<NotificationOutbox>(
          `SELECT * FROM miniapp_notification_outbox WHERE org_id=$1::uuid AND store_id=$2::uuid AND state='sending' AND dispatched_at<statement_timestamp()-interval '2 minutes' FOR UPDATE SKIP LOCKED`,
          [tenant.orgId, tenant.storeId],
        );
        for (const row of stranded.rows) {
          await client.query(
            `UPDATE miniapp_notification_outbox SET state='unknown',error_code='WECHAT_PROCESS_INTERRUPTED',checked_at=statement_timestamp() WHERE id=$1::uuid`,
            [row.id],
          );
          await audit(client, tenant, row, "unknown", "WECHAT_PROCESS_INTERRUPTED");
        }
        return (
          await client.query<{ id: string }>(
            `WITH due AS (SELECT id FROM miniapp_notification_outbox WHERE org_id=$1::uuid AND store_id=$2::uuid AND state='queued' ORDER BY checked_at NULLS FIRST,created_at,id LIMIT 3 FOR UPDATE SKIP LOCKED) UPDATE miniapp_notification_outbox target SET checked_at=statement_timestamp() FROM due WHERE target.id=due.id RETURNING target.id::text`,
            [tenant.orgId, tenant.storeId],
          )
        ).rows;
      });
    },
  });
}
