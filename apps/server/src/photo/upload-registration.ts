import type { CommandResult } from "../bus/types.js";
import type { PhotoFileStore, PhotoWrite, StoredPhoto } from "./file-store.js";

// The local runtime owns one photo root. Share locks across store instances in
// this process, and keep a queued successor's lock until that successor settles.
// This is not a cross-process lock; startup orphan recovery runs before serving.
const uploads = new Map<string, Promise<void>>();

async function serializeUpload<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = uploads.get(key);
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  uploads.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (uploads.get(key) === current) uploads.delete(key);
  }
}

type UploadOptions = Readonly<{
  bytes: Buffer;
  contentType: string;
  uploadId: string;
  register: (stored: StoredPhoto) => Promise<CommandResult>;
  referencedKeys: () => Promise<ReadonlySet<string>>;
  onCleanupDeferred: (error: unknown) => void;
}>;

async function removeUnreferencedUpload(
  files: PhotoFileStore,
  stored: PhotoWrite,
  options: UploadOptions,
): Promise<void> {
  // A replay never owns the installed file, even when authorization changed or
  // the command now conflicts. Check committed metadata before compensation.
  if (!stored.created) return;
  try {
    if (!(await options.referencedKeys()).has(stored.storage_key)) {
      await files.remove(stored.storage_key, stored.content_sha256);
    }
  } catch (error) {
    // Retain on lookup/removal failure. Startup recovery rechecks references;
    // exposing a failed upload is preferable to deleting a committed photo.
    options.onCleanupDeferred(error);
  }
}

export function registerPhotoUpload(
  files: PhotoFileStore,
  options: UploadOptions,
): Promise<CommandResult> {
  return serializeUpload(`${files.rootPath}/${options.uploadId}`, async () => {
    const stored = await files.write(options.bytes, options.contentType, options.uploadId);
    let result: CommandResult;
    try {
      result = await options.register(stored);
    } catch (error) {
      // A thrown transport/commit failure has an unknown outcome. Never unlink
      // its bytes while a database commit may still be completing.
      if (stored.created) options.onCleanupDeferred(error);
      throw error;
    }
    if (!result.ok) {
      if (
        result.error.code === "TRANSACTION_FAILED" ||
        result.error.code === "EVENT_DISPATCH_FAILED"
      ) {
        if (stored.created) options.onCleanupDeferred(new Error("Photo commit outcome unknown"));
      } else {
        await removeUnreferencedUpload(files, stored, options);
      }
    }
    return result;
  });
}
