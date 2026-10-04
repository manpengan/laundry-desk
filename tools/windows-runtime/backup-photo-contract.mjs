import { exactKeys, fail } from "./companion-contract.mjs";

export const PHOTO_MARKER = ".laundry-photo-store-v1";
export const PHOTO_MARKER_CONTENT = "laundry-desk-photo-store:v1\n";
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTO_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PHOTOS = 10_000;
export const MAX_PHOTO_INDEX_BYTES = 2 * 1024 * 1024;
export const PHOTO_KEY =
  /^(?:delivery-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;
const SHA = /^[a-f0-9]{64}$/u;

export function requirePhotoEntry(value) {
  if (
    !exactKeys(value, ["key", "size", "sha256"]) ||
    typeof value.key !== "string" ||
    !PHOTO_KEY.test(value.key) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_PHOTO_BYTES ||
    typeof value.sha256 !== "string" ||
    !SHA.test(value.sha256)
  )
    fail("BACKUP_PHOTO_ENTRY_INVALID");
  return value;
}

export function requirePhotoIndex(value) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) fail("BACKUP_PHOTO_INDEX_INVALID");
  const keys = new Set();
  let total = 0;
  for (const entry of value) {
    requirePhotoEntry(entry);
    if (keys.has(entry.key)) fail("BACKUP_PHOTO_INDEX_INVALID");
    keys.add(entry.key);
    total += entry.size;
  }
  if (total > MAX_PHOTO_TOTAL_BYTES) fail("BACKUP_PHOTO_QUOTA_EXCEEDED");
  return value;
}

export function requirePhotoManifest(value) {
  if (
    !exactKeys(value, ["index", "count", "total_bytes"]) ||
    !exactKeys(value.index, ["size", "sha256"]) ||
    !Number.isSafeInteger(value.index.size) ||
    value.index.size < 2 ||
    value.index.size > MAX_PHOTO_INDEX_BYTES ||
    typeof value.index.sha256 !== "string" ||
    !SHA.test(value.index.sha256) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    value.count > MAX_PHOTOS ||
    !Number.isSafeInteger(value.total_bytes) ||
    value.total_bytes < 0 ||
    value.total_bytes > MAX_PHOTO_TOTAL_BYTES
  )
    fail("BACKUP_PHOTO_MANIFEST_INVALID");
  return value;
}
