import { z } from "zod";
const id = z.number().int().positive().safe();
const text = z.string().max(65_536);
const epoch = z.number().int().nonnegative().max(253_402_300_799).nullable();
export const v1HistorySchema = z
  .object({
    staffs: z
      .array(
        z
          .object({
            id,
            username: text,
            display_name: text,
            role: text,
            is_active: z.union([z.literal(0), z.literal(1)]),
            created_at: epoch,
            last_login_at: epoch,
          })
          .strict(),
      )
      .max(100_000),
    sms: z
      .array(
        z
          .object({
            id,
            order_id: id.nullable(),
            phone: text,
            content: text,
            status: text,
            provider_response: text.nullable(),
            sent_at: epoch,
          })
          .strict(),
      )
      .max(100_000),
    audit: z
      .array(
        z
          .object({
            id,
            staff_id: id.nullable(),
            action: text,
            entity: text,
            entity_id: id.nullable(),
            diff: text.nullable(),
            created_at: epoch,
          })
          .strict(),
      )
      .max(100_000),
    excluded_credential_count: z.number().int().nonnegative().max(100_000),
  })
  .strict();
export type V1History = z.infer<typeof v1HistorySchema>;
