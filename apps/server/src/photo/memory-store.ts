/**
 * Process-local garment photo metadata (M3 skeleton).
 * Append-only; no blob storage.
 */

import { randomUUID } from "node:crypto";

import type { PhotoRecord, PhotoRegisterInput, PhotoStore } from "./types.js";

function tenantKey(orgId: string, storeId: string): string {
  return `${orgId}|${storeId}`;
}

export class MemoryPhotoStore implements PhotoStore {
  private readonly byId = new Map<string, PhotoRecord>();
  private readonly orderIndex = new Map<string, string[]>();

  async register(input: PhotoRegisterInput): Promise<PhotoRecord> {
    if (!Number.isInteger(input.byte_size) || input.byte_size < 1) {
      throw new RangeError("byte_size must be a positive integer");
    }
    const record: PhotoRecord = Object.freeze({
      photo_id: input.photo_id ?? randomUUID(),
      org_id: input.org_id,
      store_id: input.store_id,
      garment_id: input.garment_id,
      order_id: input.order_id,
      kind: input.kind,
      storage_key: input.storage_key,
      content_type: input.content_type,
      byte_size: input.byte_size,
      taken_at: input.taken_at,
      created_by_staff_id: input.created_by_staff_id,
    });
    this.byId.set(record.photo_id, record);
    const oKey = `${tenantKey(input.org_id, input.store_id)}|${input.order_id}`;
    const list = this.orderIndex.get(oKey) ?? [];
    list.push(record.photo_id);
    this.orderIndex.set(oKey, list);
    return record;
  }

  async listByOrder(
    orgId: string,
    storeId: string,
    orderId: string,
  ): Promise<readonly PhotoRecord[]> {
    const oKey = `${tenantKey(orgId, storeId)}|${orderId}`;
    const ids = this.orderIndex.get(oKey) ?? [];
    const rows: PhotoRecord[] = [];
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row !== undefined) rows.push(row);
    }
    rows.sort((a, b) => b.taken_at - a.taken_at);
    return Object.freeze(rows);
  }

  clear(): void {
    this.byId.clear();
    this.orderIndex.clear();
  }
}

export function createMemoryPhotoStore(): MemoryPhotoStore {
  return new MemoryPhotoStore();
}
