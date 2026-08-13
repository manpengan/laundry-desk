import type { DeliveryEvidenceHandlerDeps } from "./handlers.js";
import { createDeliveryEvidenceFileStore, type DeliveryEvidenceFileStore } from "./file-store.js";

export async function prepareDeliveryEvidenceFiles(
  photoRootPath: string | null,
  deps: DeliveryEvidenceHandlerDeps,
  orgId: string,
  storeId: string,
): Promise<DeliveryEvidenceFileStore | undefined> {
  if (photoRootPath === null) return undefined;
  const files = await createDeliveryEvidenceFileStore(photoRootPath);
  await files.sweepOrphans(await deps.store.referencedStorageKeys(orgId, storeId));
  return files;
}
