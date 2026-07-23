/**
 * M3 skeleton garment photo metadata (register + list_by_order).
 * Metadata only — storage_key is opaque; no blob / S3 in this wave.
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

export const PhotoRegisterInputSchema = z.strictObject({
  garment_id: z.uuid(),
  order_id: z.uuid(),
  kind: PhotoKindSchema,
  /** Opaque path/key; client uploads bytes elsewhere later. */
  storage_key: z.string().min(1).max(512),
  content_type: z.string().min(1).max(128).optional(),
  /** Positive integer bytes (no float). */
  byte_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Epoch seconds when photo was taken; omit = server now. */
  taken_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const PhotoListByOrderInputSchema = z.strictObject({
  order_id: z.uuid(),
});

/**
 * Photo row (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * {
 *   photo_id, garment_id, order_id, kind, storage_key,
 *   content_type, byte_size, taken_at, created_by_staff_id
 * }
 * ```
 */
export type PhotoRow = Readonly<{
  photo_id: string;
  garment_id: string;
  order_id: string;
  kind: "receive" | "defect" | "ready" | "other";
  storage_key: string;
  content_type: string;
  byte_size: number;
  /** Epoch seconds. */
  taken_at: number;
  created_by_staff_id: string;
}>;

export type PhotoRegisterResult = PhotoRow;

export type PhotoListByOrderResult = Readonly<{
  photos: readonly PhotoRow[];
}>;

type RegisterInput = typeof PhotoRegisterInputSchema;
type ListInput = typeof PhotoListByOrderInputSchema;

/** 登记衣物照片元数据：仅 storage_key，不传 blob。 */
export const photoRegisterCommand: CommandDefinition<RegisterInput> = defineCommand({
  name: "photo.register",
  version: "0.2.0",
  description: "Register garment photo metadata (opaque storage_key; no blob upload).",
  description_llm:
    "Append photo metadata for a garment on an order. kind in receive|defect|ready|other. byte_size positive integer. storage_key opaque path/key. Returns photo_id and row fields. Integer timestamps only.",
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

/** 按订单列出衣物照片元数据（无 blob）。 */
export const photoListByOrderQuery: QueryDefinition<ListInput> = defineQuery({
  name: "photo.list_by_order",
  version: "0.2.0",
  description: "List garment photo metadata rows for one order (no blobs).",
  description_llm:
    "Return photos for order_id (photo_id, garment_id, kind, storage_key, content_type, byte_size, taken_at). max 100 rows. Metadata only.",
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

export const PHOTO_COMMANDS = Object.freeze([photoRegisterCommand] as const);

export const PHOTO_COMMAND_NAMES = Object.freeze(
  PHOTO_COMMANDS.map((command) => command.name),
) as readonly ["photo.register"];

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
