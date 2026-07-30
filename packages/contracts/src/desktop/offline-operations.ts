import { z } from "zod";

import { EmptyBodySchema } from "../auth/operation-schemas.js";
import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import { CommandResponseSchema } from "../envelope/responses.js";
import { CommandNameSchema } from "../registry/primitives.js";

const DesktopFailureResultSchema = CommandResponseSchema.options[1];
const createDesktopResultSchema = <TData extends z.ZodType>(data: TData) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    DesktopFailureResultSchema,
  ]);

export const DesktopOfflineStatusInputSchema = EmptyBodySchema;
export const DesktopOfflineConflictSchema = z.strictObject({
  queue_id: z.uuid(),
  command: CommandNameSchema,
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
  created_at: ExactUtcTimestampSchema,
});
const DesktopOfflineStatusDataSchema = z.strictObject({
  pending_count: z.number().int().nonnegative().max(10_000),
  inflight_count: z.number().int().nonnegative().max(10_000),
  conflicts: z.array(DesktopOfflineConflictSchema).max(1_000),
});
export const DesktopOfflineStatusResultSchema = createDesktopResultSchema(
  DesktopOfflineStatusDataSchema,
);
export const DesktopOfflineResolveInputSchema = z.strictObject({
  queue_id: z.uuid(),
  action: z.enum(["retry", "discard"]),
});
export const DesktopOfflineResolveResultSchema = DesktopOfflineStatusResultSchema;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DesktopOfflineConflict = DeepReadonly<z.output<typeof DesktopOfflineConflictSchema>>;
export type DesktopOfflineStatusResult = DeepReadonly<
  z.output<typeof DesktopOfflineStatusResultSchema>
>;
export type DesktopOfflineResolveInput = DeepReadonly<
  z.output<typeof DesktopOfflineResolveInputSchema>
>;
