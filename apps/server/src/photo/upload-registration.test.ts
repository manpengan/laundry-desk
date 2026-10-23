import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCommandError } from "@laundry/contracts";

import type { CommandResult } from "../bus/types.js";
import { createPhotoFileStore, type StoredPhoto } from "./file-store.js";
import { registerPhotoUpload } from "./upload-registration.js";

const UPLOAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const rejected: CommandResult = Object.freeze({
  ok: false,
  error: createCommandError("PERMISSION_DENIED"),
});
const accepted: CommandResult = Object.freeze({
  ok: true,
  data: Object.freeze({ execution: "executed", result: {} }),
});

function signal() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("three queued registrations share ownership across store instances without unlocking a queued successor", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-photo-queue-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstFiles = await createPhotoFileStore({ rootPath: join(root, "photos") });
  const secondFiles = await createPhotoFileStore({ rootPath: firstFiles.rootPath });
  const thirdFiles = await createPhotoFileStore({ rootPath: firstFiles.rootPath });
  const firstEntered = signal();
  const releaseFirst = signal();
  const secondEntered = signal();
  const releaseSecond = signal();
  const events: string[] = [];
  let committed: StoredPhoto | undefined;
  const options = {
    bytes: JPEG,
    contentType: "image/jpeg",
    uploadId: UPLOAD_ID,
    referencedKeys: async () => new Set(committed ? [committed.storage_key] : []),
    onCleanupDeferred: (error: unknown) => assert.fail(String(error)),
  };
  const first = registerPhotoUpload(firstFiles, {
    ...options,
    register: async () => {
      events.push("first entered");
      firstEntered.resolve();
      await releaseFirst.promise;
      return rejected;
    },
  });
  await firstEntered.promise;
  const second = registerPhotoUpload(secondFiles, {
    ...options,
    register: async (stored) => {
      events.push("second entered");
      secondEntered.resolve();
      await releaseSecond.promise;
      committed = stored;
      events.push("second committed");
      return accepted;
    },
  });
  const third = registerPhotoUpload(thirdFiles, {
    ...options,
    register: async () => {
      events.push("third entered");
      return rejected;
    },
  });
  releaseFirst.resolve();
  assert.deepEqual(await first, rejected);
  await secondEntered.promise;
  // A fourth arrival after the first settles must queue behind the second/third.
  const fourth = registerPhotoUpload(firstFiles, {
    ...options,
    register: async () => {
      events.push("fourth entered");
      return rejected;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first entered", "second entered"]);
  releaseSecond.resolve();
  assert.deepEqual(await Promise.all([second, third, fourth]), [accepted, rejected, rejected]);
  assert.deepEqual(events, [
    "first entered",
    "second entered",
    "second committed",
    "third entered",
    "fourth entered",
  ]);
  assert.ok(committed);
  assert.deepEqual((await firstFiles.read(committed)).bytes, JPEG);
});

test("a committed reference prevents compensation even when this request created the file", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-photo-reference-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await createPhotoFileStore({ rootPath: join(root, "photos") });
  let committed: StoredPhoto | undefined;
  await registerPhotoUpload(files, {
    bytes: JPEG,
    contentType: "image/jpeg",
    uploadId: UPLOAD_ID,
    register: async (stored) => {
      committed = stored;
      return rejected;
    },
    referencedKeys: async () => new Set([`${UPLOAD_ID}.jpg`]),
    onCleanupDeferred: (error) => assert.fail(String(error)),
  });
  assert.ok(committed);
  assert.deepEqual((await files.read(committed)).bytes, JPEG);
});

for (const failure of ["lookup", "remove", "throw", "unknown commit"] as const) {
  test(`logs deferred cleanup and retains recoverable bytes on ${failure} failure`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-photo-cleanup-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const files = await createPhotoFileStore({ rootPath: join(root, "photos") });
    const errors: unknown[] = [];
    let installed: StoredPhoto | undefined;
    const result = registerPhotoUpload(
      {
        ...files,
        remove: async (...args) => {
          if (failure === "remove") throw new Error("Synthetic removal failure");
          return files.remove(...args);
        },
      },
      {
        bytes: JPEG,
        contentType: "image/jpeg",
        uploadId: UPLOAD_ID,
        register: async (stored) => {
          installed = stored;
          if (failure === "throw") throw new Error("Synthetic execution failure");
          return failure === "unknown commit"
            ? { ok: false, error: createCommandError("TRANSACTION_FAILED") }
            : rejected;
        },
        referencedKeys: async () => {
          if (failure === "lookup") throw new Error("Synthetic lookup failure");
          return new Set();
        },
        onCleanupDeferred: (error) => {
          errors.push(error);
        },
      },
    );
    if (failure === "throw") await assert.rejects(result, /Synthetic execution failure/u);
    else assert.equal((await result).ok, false);
    assert.equal(errors.length, 1);
    assert.ok(installed);
    assert.deepEqual((await files.read(installed)).bytes, JPEG);
  });
}
