/**
 * M3 garment photo metadata types (store-scoped memory / future PG).
 */

import type { PhotoContentType } from "./file-store.js";

export type PhotoKind = "receive" | "defect" | "ready" | "other";

export type PhotoRecord = Readonly<{
  photo_id: string;
  org_id: string;
  store_id: string;
  garment_id: string;
  order_id: string;
  kind: PhotoKind;
  storage_key: string;
  content_type: PhotoContentType;
  content_sha256: string | null;
  byte_size: number;
  /** Epoch seconds. */
  taken_at: number;
  created_by_staff_id: string;
}>;

export type PhotoRegisterInput = Readonly<{
  org_id: string;
  store_id: string;
  garment_id: string;
  order_id: string;
  kind: PhotoKind;
  storage_key: string;
  content_type: PhotoContentType;
  content_sha256: string;
  byte_size: number;
  /** Epoch seconds. */
  taken_at: number;
  created_by_staff_id: string;
  photo_id?: string;
}>;

export type PhotoStore = Readonly<{
  register: (input: PhotoRegisterInput) => Promise<PhotoRecord>;
  listByOrder: (orgId: string, storeId: string, orderId: string) => Promise<readonly PhotoRecord[]>;
  findById: (orgId: string, storeId: string, photoId: string) => Promise<PhotoRecord | null>;
  listStorageKeys: (orgId: string, storeId: string) => Promise<ReadonlySet<string>>;
}>;
