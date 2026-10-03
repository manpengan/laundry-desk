import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";

export const NotificationProviderSettingsSchema = z.strictObject({
  version: z.number().int().positive().max(1_000_000),
  enabled: z.boolean(),
  provider: z.literal("aliyun_sms"),
  sign_name: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[\p{L}\p{N}·]+$/u),
  template_code: z.string().regex(/^SMS_\d{1,32}$/u),
  unit_cost_cents: z.number().int().positive().max(1_000),
  max_batch_cost_cents: z.number().int().positive().max(50_000),
});
export const NotificationProviderSettingsRequestSchema = NotificationProviderSettingsSchema.omit({
  version: true,
}).extend({
  expected_version: z.number().int().nonnegative().max(999_999),
  password: z.string().min(1).max(1024),
  credential: z
    .strictObject({
      accessKeyId: z.string().regex(/^[A-Za-z0-9]{8,128}$/u),
      accessKeySecret: z.string().regex(/^[\x21-\x7e]{8,256}$/u),
    })
    .optional(),
});
export const NotificationProviderSettingsViewSchema = z.strictObject({
  settings: NotificationProviderSettingsSchema.nullable(),
  custody_available: z.boolean(),
  credential_present: z.boolean(),
});
export const NotificationSettingsOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("get") }),
  z.strictObject({ kind: z.literal("save"), input: NotificationProviderSettingsRequestSchema }),
]);
export const NotificationSettingsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: NotificationProviderSettingsViewSchema }),
  CommandResponseSchema.options[1],
]);
export type NotificationSettingsOperation = z.infer<typeof NotificationSettingsOperationSchema>;
export type NotificationProviderSettings = z.infer<typeof NotificationProviderSettingsSchema>;
export type NotificationProviderSettingsRequest = z.infer<
  typeof NotificationProviderSettingsRequestSchema
>;
export type NotificationProviderSettingsView = z.infer<
  typeof NotificationProviderSettingsViewSchema
>;
