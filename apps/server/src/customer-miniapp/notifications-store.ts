import { createHash } from "node:crypto";
import {
  WechatNotificationConfigSchema,
  WechatNotificationPayloadSchema,
  WechatNotificationPreviewSchema,
  type WechatNotificationConfig,
} from "@laundry/contracts";
import type { SqlClient, TenantContext } from "../db/types.js";
import { MiniappError, readMiniappSettings, MINIAPP_TENANT } from "./types.js";
export type NotificationConfigRow = Omit<WechatNotificationConfig, "available">;
export function requireNotificationTenant(tenant: TenantContext) {
  if (tenant.orgId !== MINIAPP_TENANT.orgId || tenant.storeId !== MINIAPP_TENANT.storeId)
    throw new MiniappError("PERMISSION_DENIED");
}
export async function readNotificationConfig(
  client: SqlClient,
  tenant: TenantContext,
  lock = false,
) {
  const row = (
    await client.query<NotificationConfigRow>(
      `SELECT version,enabled,template_id,ticket_field,store_field,status_field,miniprogram_state FROM miniapp_notification_settings WHERE org_id=$1::uuid AND store_id=$2::uuid${lock ? " FOR SHARE" : ""}`,
      [tenant.orgId, tenant.storeId],
    )
  ).rows[0];
  return row === undefined
    ? null
    : WechatNotificationConfigSchema.omit({ available: true }).parse(row);
}
export function emptyNotificationConfig(available: boolean) {
  return WechatNotificationConfigSchema.parse({
    version: 0,
    enabled: false,
    template_id: "not-configured",
    ticket_field: "character_string1",
    store_field: "thing2",
    status_field: "phrase3",
    miniprogram_state: "trial",
    available,
  });
}
export async function notificationOrder(
  client: SqlClient,
  tenant: TenantContext,
  orderId: string,
  lock: boolean,
) {
  const row = (
    await client.query<{ customer_id: string; ticket_no: string; store_name: string }>(
      `SELECT o.customer_id::text,o.ticket_no,s.name AS store_name FROM orders o JOIN customers c ON c.org_id=o.org_id AND c.id=o.customer_id JOIN stores s ON s.org_id=o.org_id AND s.id=o.store_id WHERE o.org_id=$1::uuid AND o.store_id=$2::uuid AND o.id=$3::uuid AND o.status='open' AND c.anonymized_at IS NULL AND c.merged_into_id IS NULL ${lock ? "FOR SHARE OF o,c,s" : ""}`,
      [tenant.orgId, tenant.storeId, orderId],
    )
  ).rows[0];
  if (row === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
  const garments = await client.query<{ status: string; custody_state: string }>(
    `SELECT status,custody_state FROM garments WHERE org_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid ${lock ? "FOR SHARE" : ""}`,
    [tenant.orgId, tenant.storeId, orderId],
  );
  if (
    !garments.rows.some((g) => g.status === "ready" || g.status === "racked") ||
    garments.rows.some(
      (g) =>
        !["ready", "racked", "picked_up", "delivered"].includes(g.status) ||
        (["ready", "racked"].includes(g.status) && g.custody_state !== "store"),
    )
  )
    throw new MiniappError("INVARIANT_FAILED");
  return row;
}
export async function previewNotification(
  client: SqlClient,
  tenant: TenantContext,
  orderId: string,
  lock = false,
) {
  requireNotificationTenant(tenant);
  const app = await readMiniappSettings(client, lock);
  const config = await readNotificationConfig(client, tenant, lock);
  if (
    app === null ||
    !app.enabled ||
    config === null ||
    !config.enabled ||
    !app.subscription_template_ids.includes(config.template_id)
  )
    throw new MiniappError("RESOURCE_UNAVAILABLE");
  const order = await notificationOrder(client, tenant, orderId, lock);
  const existing = await client.query(
    `SELECT id FROM miniapp_notification_outbox WHERE org_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND state IN ('queued','sending','accepted','unknown','needs_review') LIMIT 1`,
    [tenant.orgId, tenant.storeId, orderId],
  );
  if (existing.rows.length > 0) throw new MiniappError("IDEMPOTENCY_CONFLICT");
  const consent = (
    await client.query<{ id: string; binding_id: string }>(
      `SELECT c.id::text,b.id::text AS binding_id FROM miniapp_subscriptions c JOIN miniapp_sessions s ON s.org_id=c.org_id AND s.store_id=c.store_id AND s.id=c.session_id AND s.customer_id=c.customer_id JOIN miniapp_bindings b ON b.org_id=s.org_id AND b.store_id=s.store_id AND b.id=s.binding_id AND b.customer_id=c.customer_id WHERE c.org_id=$1::uuid AND c.store_id=$2::uuid AND c.customer_id=$3::uuid AND c.template_id=$4 AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND s.status='active' AND b.status='active' AND b.app_id=$5 ORDER BY c.accepted_at,c.id LIMIT 1 ${lock ? "FOR UPDATE OF c FOR SHARE OF s,b" : ""}`,
      [tenant.orgId, tenant.storeId, order.customer_id, config.template_id, app.app_id],
    )
  ).rows[0];
  if (consent === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
  const payload = WechatNotificationPayloadSchema.parse({
    ticket: order.ticket_no,
    store: [...order.store_name].slice(0, 20).join(""),
    status: "可以取衣",
  });
  const data = {
    order_id: orderId,
    customer_id: order.customer_id,
    consent_id: consent.id,
    settings_version: config.version,
    template_id: config.template_id,
    payload,
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        ...data,
        binding_id: consent.binding_id,
        miniapp_version: app.version,
        config,
      }),
    )
    .digest("hex");
  return {
    view: WechatNotificationPreviewSchema.parse({ ...data, preview_sha256: hash }),
    bindingId: consent.binding_id,
    miniappVersion: app.version,
    config,
  };
}
