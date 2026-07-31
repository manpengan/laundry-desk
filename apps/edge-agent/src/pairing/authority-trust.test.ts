import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import { MemoryAuthorityTrustStore, SafeStorageAuthorityTrustStore } from "./authority-trust.js";

const safeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`keychain:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => ciphertext.toString("utf8").slice("keychain:".length),
});

test("pins the first authority signer across restart and rejects a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-"));
  const first = generateKeyPairSync("ed25519").publicKey;
  const replacement = generateKeyPairSync("ed25519").publicKey;
  try {
    assert.equal(new SafeStorageAuthorityTrustStore(root, safeStorage).accept(first), true);
    const restarted = new SafeStorageAuthorityTrustStore(root, safeStorage);
    assert.equal(restarted.accept(first), true);
    assert.equal(restarted.accept(replacement), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory trust adapter enforces continuity within one focused test process", () => {
  const trust = new MemoryAuthorityTrustStore();
  const first = generateKeyPairSync("ed25519").publicKey;
  assert.equal(trust.accept(first), true);
  assert.equal(trust.accept(first), true);
  assert.equal(trust.accept(generateKeyPairSync("ed25519").publicKey), false);
});
