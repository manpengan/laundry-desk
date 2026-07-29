/**
 * M3 garment photo metadata (internal register + public list_by_order).
 * Not in OpenAPI freeze snapshot.
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const PhotoKindSchema = z.enum(["receive", "defect", "ready", "other"]);
export const PhotoContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const PhotoRegisterInputSchema = z.strictObject({
  garment_id: z.uuid(),
  order_id: z.uuid(),
  kind: PhotoKindSchema,
  /** Server-generated opaque key. Browser/desktop callers use the upload route. */
  storage_key: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u,
    ),
  content_type: PhotoContentTypeSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Positive integer bytes (no float). */
  byte_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Epoch seconds when photo was taken; omit = server now. */
  taken_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const PhotoListByOrderInputSchema = z.strictObject({
  order_id: z.uuid(),
});
export const PhotoDeleteInputSchema = z.strictObject({
  photo_id: z.uuid(),
});

/** Public metadata row. Storage keys and digests are deliberately absent. */
export const PhotoRowSchema = z.strictObject({
  photo_id: z.uuid(),
  garment_id: z.uuid(),
  order_id: z.uuid(),
  kind: PhotoKindSchema,
  content_type: PhotoContentTypeSchema,
  byte_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Epoch seconds. */
  taken_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  created_by_staff_id: z.uuid(),
});

export const PhotoUploadDataSchema = z.strictObject({
  execution: z.literal("executed"),
  result: PhotoRowSchema,
});

export type PhotoRow = Readonly<z.output<typeof PhotoRowSchema>>;
export type PhotoUploadData = Readonly<z.output<typeof PhotoUploadDataSchema>>;

export type PhotoRegisterResult = PhotoRow;

export type PhotoListByOrderResult = Readonly<{
  photos: readonly PhotoRow[];
}>;

type RegisterInput = typeof PhotoRegisterInputSchema;
type ListInput = typeof PhotoListByOrderInputSchema;
type DeleteInput = typeof PhotoDeleteInputSchema;

/** Internal metadata append after the trusted upload route installs bytes. */
export const photoRegisterCommand: CommandDefinition<RegisterInput> = defineCommand({
  name: "photo.register",
  version: "0.3.0",
  description: "Register server-installed garment photo metadata.",
  description_llm:
    "Internal only. Append metadata for bytes already installed by the trusted photo upload route.",
  input: PhotoRegisterInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write"],
  idempotent: false,
  sideEffects: ["photo.registered", "audit.photo_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** Internal metadata removal after the dedicated authenticated route resolves the private file. */
export const photoDeleteCommand: CommandDefinition<DeleteInput> = defineCommand({
  name: "photo.delete",
  version: "0.4.0",
  description: "Delete one garment photo through the trusted photo route.",
  description_llm:
    "Internal only. Remove one store-scoped photo metadata row with audit; file cleanup remains server-owned.",
  input: PhotoDeleteInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["photo.deleted", "audit.photo_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 按订单列出衣物照片元数据（无 blob）。 */
export const photoListByOrderQuery: QueryDefinition<ListInput> = defineQuery({
  name: "photo.list_by_order",
  version: "0.3.0",
  description: "List garment photo metadata rows for one order.",
  description_llm:
    "Return photos for order_id (photo_id, garment_id, kind, content_type, byte_size, taken_at). max 100 rows. Download bytes only through the authenticated photo_id route.",
  input: PhotoListByOrderInputSchema,
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 100,
});

export const PHOTO_COMMANDS = Object.freeze([photoRegisterCommand, photoDeleteCommand] as const);

export const PHOTO_COMMAND_NAMES = Object.freeze(
  PHOTO_COMMANDS.map((command) => command.name),
) as readonly ["photo.register", "photo.delete"];

export const PHOTO_QUERIES = Object.freeze([photoListByOrderQuery] as const);

export const PHOTO_QUERY_NAMES = Object.freeze(
  PHOTO_QUERIES.map((query) => query.name),
) as readonly ["photo.list_by_order"];

/** M3 photo command catalog (server command registry). */
export const M3_PHOTO_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...PHOTO_COMMANDS]);

export const M3_PHOTO_COMMAND_NAMES = PHOTO_COMMAND_NAMES;

/** M3 photo query catalog (server query registry). */
export const M3_PHOTO_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...PHOTO_QUERIES,
]);

export const M3_PHOTO_QUERY_NAMES = PHOTO_QUERY_NAMES;
