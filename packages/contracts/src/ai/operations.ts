import { z } from "zod";
import {
  GarmentBulkTransitionInputSchema,
  GarmentReworkInputSchema,
} from "../commands/fulfillment.js";
import { NotificationManualListCreateInputSchema } from "../commands/notification.js";

export const AiOperationDraftSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("garment.bulk_transition"),
      input: GarmentBulkTransitionInputSchema.extend({
        garment_ids: z
          .array(z.uuid())
          .min(2)
          .max(10)
          .refine((ids) => new Set(ids).size === ids.length),
      }),
    })
    .strict(),
  z
    .object({
      command: z.literal("garment.rework"),
      input: GarmentReworkInputSchema.extend({
        garment_ids: z
          .array(z.uuid())
          .min(1)
          .max(10)
          .refine((ids) => new Set(ids).size === ids.length),
      }),
    })
    .strict(),
  z
    .object({
      command: z.literal("notification.manual_list.create"),
      input: NotificationManualListCreateInputSchema.extend({
        order_ids: z
          .array(z.uuid())
          .min(1)
          .max(10)
          .refine((ids) => new Set(ids).size === ids.length),
      }),
    })
    .strict(),
]);
export const AiOperationNameSchema = z.enum([
  "garment.bulk_transition",
  "garment.rework",
  "notification.manual_list.create",
]);
/** Only the server creates this card. Frozen inputs remain in ai_pending_actions. */
export const AiOperationPreviewSchema = z
  .object({
    command: AiOperationNameSchema,
    confirm_ref: z.uuid(),
    summary: z.string().min(1).max(1024),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export const AiOperationConfirmSchema = z.object({ confirm_ref: z.uuid() }).strict();
export const AiOperationResultSchema = z
  .object({
    command: AiOperationNameSchema,
    executed: z.literal(true),
    /** A manual list is retained locally for the operator; it is never returned to the model. */
    csv: z.string().max(32_768).optional(),
  })
  .strict();
export const AiOperationResponseSchema = z
  .object({ ok: z.literal(true), data: AiOperationResultSchema })
  .strict();
export type AiOperationResult = Readonly<z.output<typeof AiOperationResultSchema>>;
export type AiOperationPreview = Readonly<z.output<typeof AiOperationPreviewSchema>>;
export type AiOperationDraft = Readonly<z.output<typeof AiOperationDraftSchema>>;
