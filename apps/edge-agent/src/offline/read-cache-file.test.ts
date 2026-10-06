import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import { OfflineReadCacheFile } from "./read-cache-file.js";

test("a failed write removes its own staging file, so the directory stays usable", () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "read-cache-file-"));
  const destination = join(root, "offline-read-cache.json");
  let occupy = true;
  const storage: SafeStorageSurface = {
    isEncryptionAvailable: () => true,
    // Runs after the destination check and before staging: a directory in the
    // destination's place makes the final replace fail after the staging file exists.
    encryptString: (text) => {
      if (occupy) {
        mkdirSync(destination);
        writeFileSync(join(destination, "occupied"), "synthetic");
      }
      return Buffer.from(`protected:${text}`);
    },
    decryptString: (bytes) => bytes.toString().slice("protected:".length),
  };
  try {
    assert.throws(() => new OfflineReadCacheFile(root, storage).write({ revision: 1 }));
    assert.deepEqual(readdirSync(root), ["offline-read-cache.json"]);

    rmSync(destination, { recursive: true });
    occupy = false;
    const reopened = new OfflineReadCacheFile(root, storage);
    reopened.write({ revision: 2 });
    assert.deepEqual(reopened.read(), { revision: 2 });
    assert.deepEqual(readdirSync(root), ["offline-read-cache.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
