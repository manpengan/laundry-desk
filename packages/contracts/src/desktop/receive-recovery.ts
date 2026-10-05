import { z } from "zod";
import { OrderReceiveInputSchema } from "../commands/order.js";
import { CommandResponseSchema } from "../envelope/responses.js";

const text = (max: number) => z.string().max(max);
const piece = z.strictObject({
  key: text(128),
  color: text(32),
  brand: text(32),
  defects_text: text(512),
  accessories_text: text(512),
  note: text(256),
  addon_codes: z.array(text(32)).max(8),
});
const line = z.strictObject({
  key: text(128),
  service_code: text(32),
  category_code: text(32),
  unit_price_cents: z.number().int().nonnegative().safe().nullable(),
  catalog_name: text(128).optional(),
  catalog_code: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u)
    .optional(),
  qty: text(16),
  garments: z.array(piece).max(50),
});
/** Editable form only: no credentials, live scale sample, or renderer-asserted receipt. */
export const ReceiveRecoveryDraftSchema = z
  .strictObject({
    operationId: z.uuid(),
    phone: text(32),
    name: text(64),
    paymentCents: text(32),
    paymentMethod: z.enum(["cash", "wechat", "alipay", "other"]),
    pricing: z.strictObject({
      discount_cents: text(32),
      urgent: z.boolean(),
      freight: z.boolean(),
    }),
    note: text(256),
    draftId: z.uuid().nullable(),
    lines: z.array(line).min(1).max(40),
    dirty: z.boolean(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
    "Recovery draft exceeds the desktop data limit",
  );
export const ReceiveRecoverySessionSchema = z.strictObject({
  session_id: z.uuid(),
  session_version: z.number().int().positive().safe(),
});
const expected = { expected_session: ReceiveRecoverySessionSchema };
export const DesktopReceiveRecoveryInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("load"), ...expected }),
  z.strictObject({ operation: z.literal("save"), ...expected, draft: ReceiveRecoveryDraftSchema }),
  z.strictObject({
    operation: z.literal("submit"),
    ...expected,
    operation_id: z.uuid(),
    body: OrderReceiveInputSchema,
  }),
]);
export const ReceiveRecoverySnapshotSchema = z.strictObject({
  draft: ReceiveRecoveryDraftSchema.nullable(),
  pending_body: OrderReceiveInputSchema.nullable(),
  receipt: CommandResponseSchema.nullable(),
});
export const DesktopReceiveRecoveryResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: ReceiveRecoverySnapshotSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(["RECOVERY_UNAVAILABLE", "RECOVERY_CONFLICT", "AUTHENTICATION_FAILED"]),
      message: text(256),
    }),
  }),
]);
export type ReceiveRecoveryDraft = z.infer<typeof ReceiveRecoveryDraftSchema>;
export type ReceiveRecoverySnapshot = z.infer<typeof ReceiveRecoverySnapshotSchema>;
export type ReceiveRecoverySession = z.infer<typeof ReceiveRecoverySessionSchema>;
export type DesktopReceiveRecoveryInput = z.infer<typeof DesktopReceiveRecoveryInputSchema>;
export type DesktopReceiveRecoveryResult = z.infer<typeof DesktopReceiveRecoveryResultSchema>;
