import { randomUUID } from "node:crypto";
import {
  createCommandError,
  WechatNotificationConfigInputSchema,
  WechatNotificationConfigSchema,
  WechatNotificationListSchema,
  WechatNotificationOrderSchema,
  WechatNotificationRecordSchema,
  WechatNotificationSendSchema,
} from "@laundry/contracts";
import { HandlerCommandError, type CommandHandler, type HandlerContext } from "../bus/types.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { MiniappError, readMiniappSettings } from "./types.js";
import {
  emptyNotificationConfig,
  previewNotification,
  readNotificationConfig,
  requireNotificationTenant,
} from "./notifications-store.js";
const recordColumns =
  "id::text,order_id::text,state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,CASE WHEN dispatched_at IS NULL THEN NULL ELSE to_char(dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END AS dispatched_at,error_code";
function guarded(
  permissions: readonly string[],
  available: boolean,
  handler: CommandHandler,
): CommandHandler {
  return async (ctx) => {
    try {
      if (!available) throw new MiniappError("RESOURCE_UNAVAILABLE");
      if (ctx.actor.via !== "ui" || permissions.some((p) => !ctx.actor.permissions?.includes(p)))
        throw new MiniappError("PERMISSION_DENIED");
      requireNotificationTenant(ctx.tenant);
      return await handler(ctx);
    } catch (error) {
      if (error instanceof MiniappError)
        throw new HandlerCommandError(createCommandError(error.code));
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        typeof error.constraint === "string" &&
        error.constraint.startsWith("miniapp_notification_")
      )
        throw new HandlerCommandError(createCommandError("IDEMPOTENCY_CONFLICT"));
      throw error;
    }
  };
}
async function configure(ctx: HandlerContext) {
  const input = WechatNotificationConfigInputSchema.parse(ctx.parsed);
  await ctx.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${ctx.tenant.orgId}:${ctx.tenant.storeId}:wechat-notification-config`,
  ]);
  const current = await readNotificationConfig(ctx.client, ctx.tenant, true);
  if ((current?.version ?? 0) !== input.expected_version)
    throw new MiniappError("IDEMPOTENCY_CONFLICT");
  const app = await readMiniappSettings(ctx.client, true);
  if (
    input.enabled &&
    (app === null || !app.enabled || !app.subscription_template_ids.includes(input.template_id))
  )
    throw new MiniappError("RESOURCE_UNAVAILABLE");
  await ctx.client.query(
    `INSERT INTO miniapp_notification_settings(org_id,store_id,version,enabled,template_id,ticket_field,store_field,status_field,miniprogram_state,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::uuid) ON CONFLICT(org_id,store_id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,template_id=EXCLUDED.template_id,ticket_field=EXCLUDED.ticket_field,store_field=EXCLUDED.store_field,status_field=EXCLUDED.status_field,miniprogram_state=EXCLUDED.miniprogram_state,updated_by=EXCLUDED.updated_by,updated_at=statement_timestamp()`,
    [
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      input.expected_version + 1,
      input.enabled,
      input.template_id,
      input.ticket_field,
      input.store_field,
      input.status_field,
      input.miniprogram_state,
      ctx.actor.staffId,
    ],
  );
  const { expected_version, ...configuration } = input;
  const result = WechatNotificationConfigSchema.parse({
    ...configuration,
    version: expected_version + 1,
    available: true,
  });
  return {
    result,
    audit: {
      entity: "miniapp_notification_settings",
      entityId: ctx.tenant.storeId,
      afterJson: JSON.stringify({
        version: result.version,
        enabled: result.enabled,
        template_id: result.template_id,
      }),
    },
  };
}
async function enqueue(ctx: HandlerContext) {
  const input = WechatNotificationSendSchema.parse(ctx.parsed);
  const preview = await previewNotification(ctx.client, ctx.tenant, input.order_id, true);
  if (preview.view.preview_sha256 !== input.preview_sha256)
    throw new MiniappError("IDEMPOTENCY_CONFLICT");
  const id = randomUUID();
  const row = (
    await ctx.client.query(
      `INSERT INTO miniapp_notification_outbox(id,org_id,store_id,order_id,customer_id,binding_id,consent_id,created_by,settings_version,miniapp_version,template_id,payload_json,preview_sha256,state) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$12::jsonb,$13,'queued') RETURNING ${recordColumns}`,
      [
        id,
        ctx.tenant.orgId,
        ctx.tenant.storeId,
        input.order_id,
        preview.view.customer_id,
        preview.bindingId,
        preview.view.consent_id,
        ctx.actor.staffId,
        preview.view.settings_version,
        preview.miniappVersion,
        preview.view.template_id,
        JSON.stringify(preview.view.payload),
        input.preview_sha256,
      ],
    )
  ).rows[0];
  const consumed = await ctx.client.query(
    `UPDATE miniapp_subscriptions SET consumed_at=statement_timestamp(),outbox_id=$4::uuid WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND consumed_at IS NULL AND revoked_at IS NULL`,
    [ctx.tenant.orgId, ctx.tenant.storeId, preview.view.consent_id, id],
  );
  if (consumed.rowCount !== 1) throw new MiniappError("IDEMPOTENCY_CONFLICT");
  return {
    result: WechatNotificationRecordSchema.parse(row),
    audit: {
      entity: "miniapp_notification_outbox",
      entityId: id,
      afterJson: JSON.stringify({
        order_id: input.order_id,
        consent_id: preview.view.consent_id,
        preview_sha256: input.preview_sha256,
        state: "queued",
      }),
    },
  };
}
export function notificationWechatHandlers(available: boolean) {
  return {
    "notification.wechat.settings.set": guarded(["store_manage"], available, configure),
    "notification.wechat.send": guarded(["customer_read", "notification_send"], available, enqueue),
    "notification.wechat.settings.get": guarded(["customer_read"], available, async (ctx) => ({
      result: WechatNotificationConfigSchema.parse({
        ...((await readNotificationConfig(ctx.client, ctx.tenant)) ??
          emptyNotificationConfig(available)),
        available,
      }),
    })),
    "notification.wechat.preview": guarded(
      ["customer_read", "notification_send"],
      available,
      async (ctx) => ({
        result: (
          await previewNotification(
            ctx.client,
            ctx.tenant,
            WechatNotificationOrderSchema.parse(ctx.parsed).order_id,
          )
        ).view,
      }),
    ),
    "notification.wechat.list": guarded(
      ["customer_read", "notification_send"],
      available,
      async (ctx) => ({
        result: WechatNotificationListSchema.parse({
          items: (
            await ctx.client.query(
              `SELECT ${recordColumns} FROM miniapp_notification_outbox WHERE org_id=$1::uuid AND store_id=$2::uuid ORDER BY created_at DESC,id LIMIT 50`,
              [ctx.tenant.orgId, ctx.tenant.storeId],
            )
          ).rows,
        }),
      }),
    ),
  };
}
export function registerWechatNotificationCommands(
  registry: MutableCommandRegistry,
  available: boolean,
) {
  const handlers = notificationWechatHandlers(available);
  for (const name of ["notification.wechat.settings.set", "notification.wechat.send"] as const)
    registry.registerHandler(name, handlers[name]);
  return ["notification.wechat.settings.set", "notification.wechat.send"];
}
export function registerWechatNotificationQueries(
  registry: MutableQueryRegistry,
  available: boolean,
) {
  const handlers = notificationWechatHandlers(available);
  for (const name of [
    "notification.wechat.settings.get",
    "notification.wechat.preview",
    "notification.wechat.list",
  ] as const)
    registry.registerHandler(name, handlers[name]);
  return [
    "notification.wechat.settings.get",
    "notification.wechat.preview",
    "notification.wechat.list",
  ];
}
