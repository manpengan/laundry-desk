import { createPhotoFileStore, type PhotoFileStore } from "./file-store.js";
import { createPgPhotoStore } from "./pg-photo-store.js";
import type { PhotoHandlerDeps } from "./handlers.js";
import type { PhotoStore } from "./types.js";
import type { PgPool } from "../db/pg-pool.js";

export async function preparePhotoFileStore(
  rootPath: string | null,
  store: PhotoStore,
  orgId: string,
  storeId: string,
): Promise<PhotoFileStore | undefined> {
  if (rootPath === null) return undefined;
  const files = await createPhotoFileStore({ rootPath });
  const referencedKeys = await store.listStorageKeys(orgId, storeId);
  await files.sweepOrphans(referencedKeys);
  return files;
}

export async function preparePgPhotoDeps(
  pool: PgPool,
  rootPath: string | null,
  orgId: string,
  storeId: string,
): Promise<PhotoHandlerDeps> {
  const store = createPgPhotoStore(pool, { orgId, storeId });
  const files = await preparePhotoFileStore(rootPath, store, orgId, storeId);
  return Object.freeze({
    store,
    ...(files === undefined ? {} : { files }),
  });
}
