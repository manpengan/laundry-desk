import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const StoreExportPreviewSchema = z.strictObject({
  policy_sha256: hash,
  table_count: z.number().int().positive().max(256),
  excluded_tables: z.array(z.strictObject({ name: z.string(), reason: z.string() })).max(256),
  scope: z.literal("current_store_and_shared_org_resources"),
  includes_customer_pii: z.literal(true),
  includes_all_referenced_photos: z.literal(true),
});
export const StoreExportApprovalSchema = z.strictObject({
  password: z.string().min(1).max(1024),
  policy_sha256: hash,
  privacy_acknowledged: z.literal(true),
});
export const StoreExportApprovedSchema = z.strictObject({
  request_id: z.uuid(),
  expires_at: z.number().int().safe().positive(),
});
export const DesktopStoreExportInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("preview") }),
  z.strictObject({ operation: z.literal("authorize"), body: StoreExportApprovalSchema }),
]);
export const DesktopStoreExportResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    data: z.union([StoreExportPreviewSchema, StoreExportApprovedSchema]),
  }),
  CommandResponseSchema.options[1],
]);
export type StoreExportPreview = z.infer<typeof StoreExportPreviewSchema>;
export type StoreExportApproval = z.infer<typeof StoreExportApprovalSchema>;
export type StoreExportApproved = z.infer<typeof StoreExportApprovedSchema>;
export type DesktopStoreExportInput = z.infer<typeof DesktopStoreExportInputSchema>;
