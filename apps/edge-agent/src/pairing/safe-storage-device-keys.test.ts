import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import { SafeStorageDeviceKeyStore } from "./safe-storage-device-keys.js";

const fakeSafeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`keychain:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => {
    const value = ciphertext.toString("utf8");
    if (!value.startsWith("keychain:")) throw new Error("invalid protected key");
    return value.slice("keychain:".length);
  },
});

test("Keychain-backed device key survives restart without plaintext private material", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-device-key-"));
  try {
    const first = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
    const generated = first.generate();
    const publicKey = generated.exportPublic().publicKeySpkiBase64Url;
    const stored = await readFile(join(root, "device-signing-key.json"), "utf8");
    assert.match(stored, /protected_private_key/u);
    assert.doesNotMatch(stored, /PRIVATE KEY|BEGIN|END/u);

    const restarted = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
    assert.equal(restarted.load()?.exportPublic().publicKeySpkiBase64Url, publicKey);
    restarted.clear();
    assert.equal(restarted.load(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device key store refuses to start without OS encryption", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-device-key-"));
  try {
    assert.throws(
      () =>
        new SafeStorageDeviceKeyStore(
          root,
          Object.freeze({
            ...fakeSafeStorage,
            isEncryptionAvailable: () => false,
          }),
        ),
      /Keychain/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
