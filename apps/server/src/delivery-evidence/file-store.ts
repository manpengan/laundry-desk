import { join } from "node:path";

import {
  createPhotoFileStore,
  type PhotoFileStore,
  type StoredPhoto,
} from "../photo/file-store.js";

const EXTERNAL_KEY = /^delivery-([0-9a-f-]{36}\.(?:jpg|png|webp))$/u;

export type DeliveryEvidenceFileStore = Readonly<{
  rootPath: string;
  write: (bytes: Buffer, declaredType: string) => Promise<StoredPhoto>;
  read: (metadata: StoredPhoto) => ReturnType<PhotoFileStore["read"]>;
  remove: (storageKey: string, expectedSha256: string) => Promise<boolean>;
  sweepOrphans: (referencedKeys: ReadonlySet<string>) => Promise<void>;
}>;

const externalKey = (internal: string): string => `delivery-${internal}`;
const internalKey = (external: string): string => {
  const match = EXTERNAL_KEY.exec(external);
  if (match?.[1] === undefined) throw new TypeError("Invalid delivery evidence storage key");
  return match[1];
};

export async function createDeliveryEvidenceFileStore(
  photoRootPath: string,
): Promise<DeliveryEvidenceFileStore> {
  const files = await createPhotoFileStore({ rootPath: join(photoRootPath, "delivery-evidence") });
  return Object.freeze({
    rootPath: files.rootPath,
    async write(bytes, declaredType) {
      const stored = await files.write(bytes, declaredType);
      return Object.freeze({ ...stored, storage_key: externalKey(stored.storage_key) });
    },
    read: (metadata) =>
      files.read(Object.freeze({ ...metadata, storage_key: internalKey(metadata.storage_key) })),
    remove: (storageKey, expectedSha256) => files.remove(internalKey(storageKey), expectedSha256),
    async sweepOrphans(referencedKeys) {
      await files.sweepOrphans(new Set([...referencedKeys].map(internalKey)));
    },
  });
}
