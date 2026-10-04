import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";

export const V1_MIGRATION_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
export const V1_MIGRATION_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const count = z.number().int().safe().nonnegative();
const totals = z.strictObject({
  orders: count,
  garments: count,
  customers: count,
  receivableCents: count,
  paidCents: count,
  debtCents: count,
  photos: count,
});
const difference = z.number().int().safe();
const differences = z.strictObject({
  orders: difference,
  garments: difference,
  customers: difference,
  receivableCents: difference,
  paidCents: difference,
  debtCents: difference,
  photos: difference,
});
export const V1MigrationPreviewSchema = z.strictObject({
  reassigned_pickup_codes: count,
  history: z.strictObject({
    staffs: count,
    sms: count,
    audit: count,
    excluded_credentials: count,
    privacy_policy: z.literal("erase_all_imported_audit_and_unowned_sms_on_customer_erasure"),
  }),
  draft_id: z.uuid(),
  source_sha256: hash,
  plan_sha256: hash,
  expires_at: count,
  report: z.strictObject({
    sourceBackupSha256: hash,
    source: totals,
    target: totals,
    differences,
    isZeroDifference: z.literal(true),
  }),
  photos: z
    .array(
      z.strictObject({
        id: z.uuid(),
        source_relative_path: z.string().min(1).max(4096),
        garment_id: z.uuid(),
        association: z.literal("first_garment_in_legacy_order"),
      }),
    )
    .max(1000),
  warnings: z
    .array(
      z.strictObject({
        code: z.literal("MISSING_DATE_DEFAULTED"),
        legacyOrderId: count,
        field: z.enum(["createdAt", "updatedAt"]),
      }),
    )
    .max(200_000),
});
export const V1MigrationReviewSchema = V1MigrationPreviewSchema.extend({ photos_sha256: hash });
export const V1MigrationApprovalSchema = z.strictObject({
  source_sha256: hash,
  plan_sha256: hash,
  photos_sha256: hash,
  photo_associations_reviewed: z.literal(true),
  password: z.string().min(1).max(1024),
});
export const V1MigrationApprovedSchema = z.strictObject({
  request_id: z.uuid(),
  expires_at: count,
});
const bytes = (limit: number) =>
  z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= limit);
export const DesktopV1MigrationInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("draft"), bytes: bytes(V1_MIGRATION_SOURCE_MAX_BYTES) }),
  z.strictObject({
    operation: z.literal("photo"),
    draft_id: z.uuid(),
    photo_id: z.uuid(),
    bytes: bytes(V1_MIGRATION_PHOTO_MAX_BYTES),
  }),
  z.strictObject({ operation: z.literal("review"), draft_id: z.uuid() }),
  z.strictObject({
    operation: z.literal("authorize"),
    draft_id: z.uuid(),
    body: V1MigrationApprovalSchema,
  }),
]);
export const DesktopV1MigrationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    data: z.union([
      V1MigrationPreviewSchema,
      V1MigrationReviewSchema,
      V1MigrationApprovedSchema,
      z.strictObject({ uploaded: z.literal(true) }),
    ]),
  }),
  CommandResponseSchema.options[1],
]);
export type V1MigrationPreview = z.infer<typeof V1MigrationPreviewSchema>;
export type V1MigrationReview = z.infer<typeof V1MigrationReviewSchema>;
export type V1MigrationApproval = z.infer<typeof V1MigrationApprovalSchema>;
export type V1MigrationApproved = z.infer<typeof V1MigrationApprovedSchema>;
export type DesktopV1MigrationInput = z.infer<typeof DesktopV1MigrationInputSchema>;
export type DesktopV1MigrationResult = z.infer<typeof DesktopV1MigrationResultSchema>;
