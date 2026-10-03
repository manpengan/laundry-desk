import { z } from "zod";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "./registry/definitions.js";
const TemplateId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const WechatNotificationConfigInputSchema = z.strictObject({
  expected_version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  template_id: TemplateId,
  ticket_field: z.string().regex(/^character_string[0-9]{1,3}$/u),
  store_field: z.string().regex(/^thing[0-9]{1,3}$/u),
  status_field: z.string().regex(/^phrase[0-9]{1,3}$/u),
  miniprogram_state: z.enum(["developer", "trial", "formal"]),
});
export const WechatNotificationConfigSchema = WechatNotificationConfigInputSchema.omit({
  expected_version: true,
}).extend({ version: z.number().int().nonnegative(), available: z.boolean() });
export const WechatNotificationOrderSchema = z.strictObject({ order_id: z.uuid() });
export const WechatNotificationPayloadSchema = z.strictObject({
  ticket: z.string().regex(/^[\x21-\x7e]{1,32}$/u),
  store: z.string().min(1).max(40),
  status: z.literal("可以取衣"),
});
export const WechatNotificationPreviewSchema = z.strictObject({
  order_id: z.uuid(),
  customer_id: z.uuid(),
  consent_id: z.uuid(),
  settings_version: z.number().int().positive(),
  template_id: TemplateId,
  payload: WechatNotificationPayloadSchema,
  preview_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const WechatNotificationSendSchema = z.strictObject({
  order_id: z.uuid(),
  preview_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const WechatNotificationStatusSchema = z.enum([
  "queued",
  "sending",
  "accepted",
  "failed",
  "unknown",
  "cancelled",
  "needs_review",
]);
export const WechatNotificationRecordSchema = z.strictObject({
  id: z.uuid(),
  order_id: z.uuid(),
  state: WechatNotificationStatusSchema,
  created_at: z.iso.datetime(),
  dispatched_at: z.iso.datetime().nullable(),
  error_code: z.string().max(80).nullable(),
});
export const WechatNotificationListSchema = z.strictObject({
  items: z.array(WechatNotificationRecordSchema).max(50),
});
const Empty = z.strictObject({});
export const wechatNotificationConfigure: CommandDefinition<
  typeof WechatNotificationConfigInputSchema
> = defineCommand({
  name: "notification.wechat.settings.set",
  version: "1.0.0",
  description: "Configure the fixed WeChat pickup subscription template.",
  description_llm:
    "Configure the store-owned fixed template after human confirmation. No credentials or arbitrary message text are accepted.",
  input_redaction: [],
  result_redaction: [],
  input: WechatNotificationConfigInputSchema,
  risk: "R3",
  invariants: ["rbac.store_manage"],
  idempotent: true,
  sideEffects: ["notification.wechat_configured", "audit.notification_event"],
  offline_mode: "denied",
  data_classification: "internal",
});
export const wechatNotificationSend: CommandDefinition<typeof WechatNotificationSendSchema> =
  defineCommand({
    name: "notification.wechat.send",
    version: "1.0.0",
    description:
      "After human confirmation enqueue one ready-order notification using one accepted subscription.",
    description_llm:
      "Consume one accepted subscription after human confirmation. The preview digest binds the exact current ready order and template. No automatic campaigns or retries.",
    input_redaction: [],
    result_redaction: [],
    input: WechatNotificationSendSchema,
    risk: "R3",
    invariants: ["rbac.customer_read", "rbac.notification_send"],
    idempotent: true,
    sideEffects: ["notification.wechat_queued", "audit.notification_event"],
    offline_mode: "denied",
    data_classification: "pii",
  });
export const wechatNotificationConfigQuery: QueryDefinition<typeof Empty> = defineQuery({
  name: "notification.wechat.settings.get",
  version: "1.0.0",
  description: "Read fixed WeChat notification configuration.",
  input: Empty,
  description_llm: "Read non-secret notification template settings.",
  input_redaction: [],
  result_redaction: [],
  risk: "R1",
  invariants: ["rbac.customer_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  max_result_rows: 1,
});
export const wechatNotificationPreviewQuery: QueryDefinition<typeof WechatNotificationOrderSchema> =
  defineQuery({
    name: "notification.wechat.preview",
    version: "1.0.0",
    description:
      "Preview the exact ready-order message and available subscription before confirmation.",
    input: WechatNotificationOrderSchema,
    description_llm:
      "Return a bounded store-scoped projection for a human operator. No recipient credential is exposed.",
    input_redaction: [],
    result_redaction: [
      { path: "/customer_id", strategy: "mask" },
      { path: "/consent_id", strategy: "remove" },
      { path: "/payload", strategy: "remove" },
    ],
    risk: "R2",
    invariants: ["rbac.customer_read", "rbac.notification_send"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    max_result_rows: 1,
  });
export const wechatNotificationListQuery: QueryDefinition<typeof Empty> = defineQuery({
  name: "notification.wechat.list",
  version: "1.0.0",
  description:
    "List the latest fifty notification acknowledgement states; accepted is not proof of delivery.",
  input: Empty,
  description_llm:
    "Return a bounded store-scoped projection for a human operator. No recipient credential is exposed.",
  input_redaction: [],
  result_redaction: [],
  risk: "R2",
  invariants: ["rbac.customer_read", "rbac.notification_send"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  max_result_rows: 50,
});
export const WECHAT_NOTIFICATION_COMMANDS = Object.freeze([
  wechatNotificationConfigure,
  wechatNotificationSend,
]);
export const WECHAT_NOTIFICATION_QUERIES = Object.freeze([
  wechatNotificationConfigQuery,
  wechatNotificationPreviewQuery,
  wechatNotificationListQuery,
]);
export type WechatNotificationConfig = z.output<typeof WechatNotificationConfigSchema>;
export type WechatNotificationPreview = z.output<typeof WechatNotificationPreviewSchema>;
export type WechatNotificationRecord = z.output<typeof WechatNotificationRecordSchema>;
