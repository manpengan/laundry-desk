import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";

const AppId = z.string().regex(/^wx[A-Za-z0-9]{16}$/u);
const TemplateIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)).max(3);
export const MiniappSettingsSaveSchema = z
  .strictObject({
    password: z.string().min(1).max(1024),
    expected_version: z.number().int().nonnegative().max(2147483646),
    enabled: z.boolean(),
    transactions_enabled: z.boolean(),
    delegated_staff_id: z.uuid().nullable(),
    app_id: AppId,
    app_secret: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/u)
      .optional(),
    subscription_template_ids: TemplateIds,
  })
  .refine(
    (value) => !value.transactions_enabled || (value.enabled && value.delegated_staff_id !== null),
  );
export const MiniappSettingsViewSchema = z.strictObject({
  custody_available: z.boolean(),
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  transactions_enabled: z.boolean(),
  delegated_staff_id: z.uuid().nullable(),
  app_id: AppId.nullable(),
  eligible_staff: z
    .array(z.strictObject({ staff_id: z.uuid(), display_name: z.string().min(1).max(128) }))
    .max(100)
    .default([]),
  credential_present: z.boolean(),
  subscription_template_ids: TemplateIds,
});
export const DesktopMiniappSettingsInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read") }),
  z.strictObject({ operation: z.literal("save"), body: MiniappSettingsSaveSchema }),
]);
export const DesktopMiniappSettingsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: MiniappSettingsViewSchema }),
  CommandResponseSchema.options[1],
]);
export type MiniappSettingsView = z.infer<typeof MiniappSettingsViewSchema>;
export type MiniappSettingsSave = z.infer<typeof MiniappSettingsSaveSchema>;
export type DesktopMiniappSettingsInput = z.infer<typeof DesktopMiniappSettingsInputSchema>;
