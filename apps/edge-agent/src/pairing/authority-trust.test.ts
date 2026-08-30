import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";

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

test("authority trust state and its root stay owner-private", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-mode-"));
  try {
    new SafeStorageAuthorityTrustStore(root, safeStorage).accept(
      generateKeyPairSync("ed25519").publicKey,
    );
    if (process.platform === "win32") {
      assert.equal((await inspectPrivateDirectory(root)).scheme, "windows-dacl-v1");
      assert.equal(
        (await inspectPrivateFile(join(root, "authority-trust.json"))).scheme,
        "windows-dacl-v1",
      );
    } else {
      assert.equal((await lstat(root)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(root, "authority-trust.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority trust state rejects symlinks, hard links, and public modes", async (t) => {
  await t.test("symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-symlink-"));
    try {
      const target = join(root, "target.json");
      await writeFile(target, "{}\n", { mode: 0o600 });
      await symlink(target, join(root, "authority-trust.json"));
      const trust = new SafeStorageAuthorityTrustStore(root, safeStorage);
      assert.throws(() => trust.accept(generateKeyPairSync("ed25519").publicKey), /symlink/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("hard link", async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-hardlink-"));
    try {
      const authority = generateKeyPairSync("ed25519").publicKey;
      const trust = new SafeStorageAuthorityTrustStore(root, safeStorage);
      trust.accept(authority);
      await link(join(root, "authority-trust.json"), join(root, "duplicate.json"));
      assert.throws(() => trust.accept(authority), /private/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("public mode", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-public-"));
    try {
      const authority = generateKeyPairSync("ed25519").publicKey;
      const trust = new SafeStorageAuthorityTrustStore(root, safeStorage);
      trust.accept(authority);
      await chmod(join(root, "authority-trust.json"), 0o644);
      assert.throws(() => trust.accept(authority), /private/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("attacker-controlled authority staging paths are never followed or truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-staging-"));
  const stagingId = "b".repeat(24);
  try {
    const target = join(root, "do-not-overwrite.txt");
    const staging = join(root, `.authority-trust.json.${stagingId}.staging`);
    await writeFile(target, "sentinel", { mode: 0o600 });
    await symlink(target, staging);
    const trust = new SafeStorageAuthorityTrustStore(root, safeStorage, {
      randomStagingId: () => stagingId,
    });

    assert.throws(() => trust.accept(generateKeyPairSync("ed25519").publicKey), /EEXIST/u);
    assert.equal(await readFile(target, "utf8"), "sentinel");
    assert.equal((await lstat(staging)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority trust path replacement during read is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-authority-trust-race-"));
  try {
    const path = join(root, "authority-trust.json");
    const authority = generateKeyPairSync("ed25519").publicKey;
    new SafeStorageAuthorityTrustStore(root, safeStorage).accept(authority);
    const original = await readFile(path);
    let replaced = false;
    const racing = new SafeStorageAuthorityTrustStore(root, safeStorage, {
      afterReadBytes: () => {
        if (replaced) return;
        replaced = true;
        renameSync(path, join(root, "authority-trust.old"));
        writeFileSync(path, original, { mode: 0o600 });
      },
    });
    assert.throws(() => racing.accept(authority), /path changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
