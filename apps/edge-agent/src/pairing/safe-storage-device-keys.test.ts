import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";

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

test("OS-protected device key survives restart without plaintext private material", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-device-key-"));
  try {
    const first = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
    const generated = first.generate();
    const publicKey = generated.exportPublic().publicKeySpkiBase64Url;
    const stored = await readFile(join(root, "device-signing-key.json"), "utf8");
    assert.match(stored, /protected_private_key/u);
    // PEM armour is matched with its dashes. A bare /BEGIN|END/ also matches the
    // base64 of the protected blob by chance — those letters are in the base64
    // alphabet — which turned this security guard into a ~0.18% random red that
    // reviewers would re-run away.
    assert.doesNotMatch(stored, /PRIVATE KEY|-----BEGIN|-----END/u);

    // Absence of scary words is weak evidence. Assert the positive property the
    // guard exists for: what landed on disk is the protected form, and the raw
    // PKCS#8 body is not recoverable from the file without the OS keychain.
    const parsed = JSON.parse(stored) as Readonly<{ protected_private_key: string }>;
    const protectedBytes = Buffer.from(parsed.protected_private_key, "base64");
    assert.equal(protectedBytes.toString("utf8").startsWith("keychain:"), true);
    const plaintextPkcs8 = protectedBytes.toString("utf8").slice("keychain:".length);
    assert.equal(stored.includes(plaintextPkcs8), false);

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
      /protected storage/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device key state and its root stay owner-private", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-device-key-mode-"));
  try {
    const store = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
    store.generate();
    if (process.platform === "win32") {
      assert.equal((await inspectPrivateDirectory(root)).scheme, "windows-dacl-v1");
      assert.equal(
        (await inspectPrivateFile(join(root, "device-signing-key.json"))).scheme,
        "windows-dacl-v1",
      );
    } else {
      assert.equal((await lstat(root)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(root, "device-signing-key.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device key state rejects symlinks, hard links, and public modes", async (t) => {
  await t.test("symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-device-key-symlink-"));
    try {
      const target = join(root, "target.json");
      await writeFile(target, "{}\n", { mode: 0o600 });
      await symlink(target, join(root, "device-signing-key.json"));
      const store = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
      assert.throws(() => store.load(), /symlink/u);
      assert.throws(() => store.clear(), /symlink/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("hard link", async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-device-key-hardlink-"));
    try {
      const store = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
      store.generate();
      await link(join(root, "device-signing-key.json"), join(root, "duplicate.json"));
      assert.throws(() => store.load(), /private/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("public mode", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-device-key-public-"));
    try {
      const store = new SafeStorageDeviceKeyStore(root, fakeSafeStorage);
      store.generate();
      await chmod(join(root, "device-signing-key.json"), 0o644);
      assert.throws(() => store.load(), /private/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("attacker-controlled staging paths are never followed or truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-device-key-staging-"));
  const stagingId = "a".repeat(24);
  try {
    const target = join(root, "do-not-overwrite.txt");
    const staging = join(root, `.device-signing-key.json.${stagingId}.staging`);
    await writeFile(target, "sentinel", { mode: 0o600 });
    await symlink(target, staging);
    const store = new SafeStorageDeviceKeyStore(root, fakeSafeStorage, {
      randomStagingId: () => stagingId,
    });

    assert.throws(() => store.generate(), /EEXIST/u);
    assert.equal(await readFile(target, "utf8"), "sentinel");
    assert.equal((await lstat(staging)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path replacement during load or before clear is rejected", async (t) => {
  await t.test("load replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-device-key-read-race-"));
    try {
      const path = join(root, "device-signing-key.json");
      new SafeStorageDeviceKeyStore(root, fakeSafeStorage).generate();
      const original = await readFile(path);
      let replaced = false;
      const racing = new SafeStorageDeviceKeyStore(root, fakeSafeStorage, {
        afterReadBytes: () => {
          if (replaced) return;
          replaced = true;
          renameSync(path, join(root, "device-signing-key.old"));
          writeFileSync(path, original, { mode: 0o600 });
        },
      });
      assert.throws(() => racing.load(), /path changed/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("clear replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-device-key-clear-race-"));
    try {
      const path = join(root, "device-signing-key.json");
      new SafeStorageDeviceKeyStore(root, fakeSafeStorage).generate();
      const original = await readFile(path);
      const racing = new SafeStorageDeviceKeyStore(root, fakeSafeStorage, {
        beforeClearRevalidate: () => {
          renameSync(path, join(root, "device-signing-key.old"));
          writeFileSync(path, original, { mode: 0o600 });
        },
      });
      assert.throws(() => racing.clear(), /changed before clear/u);
      assert.equal((await lstat(path)).isFile(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
