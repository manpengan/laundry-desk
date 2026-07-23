/**
 * M3 photo handlers: photo.register + photo.list_by_order.
 */

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { PhotoKind, PhotoRecord, PhotoStore } from "./types.js";

export type PhotoHandlerDeps = Readonly<{
  store: PhotoStore;
  now?: () => number;
}>;

const KIND_SET: ReadonlySet<string> = new Set(["receive", "defect", "ready", "other"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireKind(value: unknown): PhotoKind {
  if (typeof value !== "string" || !KIND_SET.has(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value as PhotoKind;
}

function requireStorageKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireByteSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function parseContentType(value: unknown): string {
  if (value === undefined) return "image/jpeg";
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function parseTakenAt(value: unknown, now: number): number {
  if (value === undefined) return now;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function toRow(record: PhotoRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    photo_id: record.photo_id,
    garment_id: record.garment_id,
    order_id: record.order_id,
    kind: record.kind,
    storage_key: record.storage_key,
    content_type: record.content_type,
    byte_size: record.byte_size,
    taken_at: record.taken_at,
    created_by_staff_id: record.created_by_staff_id,
  });
}

function registerHandler(deps: PhotoHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const garmentId = requireUuid(input.garment_id);
    const orderId = requireUuid(input.order_id);
    const kind = requireKind(input.kind);
    const storageKey = requireStorageKey(input.storage_key);
    const contentType = parseContentType(input.content_type);
    const byteSize = requireByteSize(input.byte_size);
    const takenAt = parseTakenAt(input.taken_at, now);

    const record = await deps.store.register({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      garment_id: garmentId,
      order_id: orderId,
      kind,
      storage_key: storageKey,
      content_type: contentType,
      byte_size: byteSize,
      taken_at: takenAt,
      created_by_staff_id: ctx.actor.staffId,
    });

    return Object.freeze({
      result: toRow(record),
      audit: Object.freeze({
        entity: "garment_photo",
        entityId: record.photo_id,
        afterJson: JSON.stringify({
          order_id: record.order_id,
          garment_id: record.garment_id,
          kind: record.kind,
          storage_key: record.storage_key,
          byte_size: record.byte_size,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "photo.registered",
          payload: Object.freeze({
            photo_id: record.photo_id,
            order_id: record.order_id,
            garment_id: record.garment_id,
            kind: record.kind,
          }),
        }),
      ]),
    });
  };
}

function listByOrderHandler(deps: PhotoHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const orderId = requireUuid(input.order_id);
    const rows = await deps.store.listByOrder(ctx.tenant.orgId, ctx.tenant.storeId, orderId);
    return Object.freeze({
      result: Object.freeze({
        photos: Object.freeze(rows.map((row) => toRow(row))),
      }),
    });
  };
}

export function registerPhotoCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PhotoHandlerDeps,
): void {
  registry.registerHandler("photo.register", registerHandler(deps));
}

export function registerPhotoQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PhotoHandlerDeps,
): void {
  registry.registerHandler("photo.list_by_order", listByOrderHandler(deps));
}
