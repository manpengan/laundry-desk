import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DesktopQueryExecuteResultSchema,
  DesktopSessionViewSchema,
  canonicalizeOfflineGrantForSigning,
  createOfflineGrantRegistrySnapshot,
  type DesktopSessionView,
  type OfflineGrantPayload,
} from "@laundry/contracts";
import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";

import { bytesToBase64Url } from "../pairing/device-keys.js";
import { MemoryAuthorityTrustStore } from "../pairing/authority-trust.js";
import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import type { VerifiedOfflineReadAuthority } from "./read-authority.js";
import { OfflineReadCache } from "./read-cache.js";

const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const SESSION_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const keys = generateKeyPairSync("ed25519");
const registry = createOfflineGrantRegistrySnapshot();

const safeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`keychain:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => {
    const text = ciphertext.toString("utf8");
    if (!text.startsWith("keychain:")) throw new Error("missing Keychain item");
    return text.slice("keychain:".length);
  },
});

function sessionOf(overrides: Partial<DesktopSessionView["session"]> = {}): DesktopSessionView {
  return DesktopSessionViewSchema.parse({
    session: {
      session_id: SESSION_ID,
      session_version: 7,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 3,
      ...overrides,
    },
    role: "staff",
    features: { member_enabled: true },
    display: {
      store_name: "本地门店",
      staff_name: "店员",
      org_code: "local",
      store_code: "main",
    },
  });
}

function authorityFor(
  session: DesktopSessionView,
  issuedAt = "2026-07-30T00:00:00.000Z",
  notAfter = "2026-07-30T12:00:00.000Z",
): VerifiedOfflineReadAuthority {
  const payload: OfflineGrantPayload = Object.freeze({
    grant_id: "51a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    org_id: session.session.org_id,
    store_id: session.session.store_id,
    staff_id: session.session.staff_id,
    device_id: session.session.device_id,
    request_nonce: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    permission_version: session.session.permission_version,
    allowed_commands: Object.freeze(["order.pickup"]),
    issued_at: issuedAt,
    ttl_ms: Date.parse(notAfter) - Date.parse(issuedAt),
    not_after: notAfter,
  });
  const unsigned = Object.freeze({ protocol_version: "1.0.0", payload });
  return Object.freeze({
    serverPublicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    offlineGrant: Object.freeze({
      ...unsigned,
      sig: bytesToBase64Url(
        new Uint8Array(
          sign(null, canonicalizeOfflineGrantForSigning(unsigned, registry), keys.privateKey),
        ),
      ),
    }),
  });
}

const orderListInput = Object.freeze({
  name: "order.list",
  body: Object.freeze({ status: "open", limit: 20 }),
});
const orderListResult = DesktopQueryExecuteResultSchema.parse({
  ok: true,
  data: {
    execution: "executed",
    result: {
      orders: [{ order_id: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678", phone: "13800000001" }],
    },
  },
});

function createCache(root: string, now: () => Date, storage = safeStorage) {
  return new OfflineReadCache({
    rootPath: root,
    safeStorage: storage,
    authorityTrust: new MemoryAuthorityTrustStore(),
    now,
  });
}

test("encrypts the strict query cache as one private atomic file and restores exact keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-read-cache-"));
  let nowMs = Date.parse("2026-07-30T01:00:00.000Z");
  try {
    const session = sessionOf();
    const cache = createCache(root, () => new Date(nowMs));
    cache.bind(session, authorityFor(session));
    assert.equal(await cache.put(session, orderListInput, orderListResult), true);

    const path = join(root, "offline-read-cache.json");
    const wire = await readFile(path, "utf8");
    assert.doesNotMatch(wire, /order\.list|13800000001|session_id|offline_grant/u);
    if (process.platform === "win32") {
      assert.equal((await inspectPrivateDirectory(root)).scheme, "windows-dacl-v1");
      assert.equal((await inspectPrivateFile(path)).scheme, "windows-dacl-v1");
    } else {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await cache.get(session, orderListInput), orderListResult);
    assert.equal(
      await cache.get(session, { name: "order.list", body: { status: "closed", limit: 20 } }),
      null,
    );
    assert.equal(
      await cache.put(
        session,
        {
          name: "customer.duplicates",
          body: { customer_id: "71a2eed0-a6c3-493c-a3a7-20bf94b1d678" },
        },
        orderListResult,
      ),
      false,
    );

    nowMs += 1_000;
    const resumed = cache.resume();
    assert.equal(resumed?.cachedQueryCount, 1);
    assert.doesNotMatch(
      JSON.stringify(resumed),
      /access_token|refresh_token|authorization|cookie|password|pin|secret/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for ciphertext tampering, unavailable protected key, and symlink files", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-read-cache-"));
  const now = () => new Date("2026-07-30T01:00:00.000Z");
  try {
    const session = sessionOf();
    const cache = createCache(root, now);
    cache.bind(session, authorityFor(session));
    await cache.put(session, orderListInput, orderListResult);
    const path = join(root, "offline-read-cache.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const ciphertext = String(parsed.ciphertext);
    const flipped = ciphertext.startsWith("A") ? "B" : "A";
    await writeFile(
      path,
      JSON.stringify({ ...parsed, ciphertext: `${flipped}${ciphertext.slice(1)}` }),
    );
    assert.equal(cache.resume(), null);

    cache.bind(session, authorityFor(session));
    const missingKeyStorage: SafeStorageSurface = Object.freeze({
      isEncryptionAvailable: () => true,
      encryptString: safeStorage.encryptString,
      decryptString: () => {
        throw new Error("Keychain item deleted");
      },
    });
    assert.equal(createCache(root, now, missingKeyStorage).resume(), null);

    cache.clear();
    const target = join(root, "target.json");
    await writeFile(target, "{}");
    await symlink(target, path);
    assert.equal(cache.resume(), null);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.throws(() => cache.bind(session, authorityFor(session)), /Invalid offline read cache/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies the signed grant before accepting a first-use signer pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-read-cache-"));
  let pinCalls = 0;
  try {
    const session = sessionOf();
    const authority = authorityFor(session);
    const cache = new OfflineReadCache({
      rootPath: root,
      safeStorage,
      authorityTrust: {
        accept: () => {
          pinCalls += 1;
          return true;
        },
      },
      now: () => new Date("2026-07-30T01:00:00.000Z"),
    });
    const invalid: VerifiedOfflineReadAuthority = Object.freeze({
      ...authority,
      offlineGrant: Object.freeze({
        ...authority.offlineGrant,
        sig: "A".repeat(86),
      }),
    });

    assert.throws(() => cache.bind(session, invalid), /authority is invalid/u);
    assert.equal(pinCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects expired grants, wall-clock rollback, and mismatched session context", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-read-cache-"));
  let nowMs = Date.parse("2026-07-30T01:00:00.000Z");
  try {
    const session = sessionOf();
    const cache = createCache(root, () => new Date(nowMs));
    cache.bind(session, authorityFor(session));
    await cache.put(session, orderListInput, orderListResult);
    assert.equal(await cache.get(sessionOf({ session_version: 8 }), orderListInput), null);
    nowMs += 10_000;
    assert.notEqual(await cache.get(session, orderListInput), null);
    nowMs -= 5_000;
    assert.equal(cache.resume(), null);

    nowMs = Date.parse("2026-07-30T12:00:00.000Z");
    assert.equal(cache.resume(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful staff or tenant switch replaces prior cached projections and logout clears", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-read-cache-"));
  const now = () => new Date("2026-07-30T01:00:00.000Z");
  try {
    const first = sessionOf();
    const cache = createCache(root, now);
    cache.bind(first, authorityFor(first));
    await cache.put(first, orderListInput, orderListResult);

    const second = sessionOf({
      session_id: "81a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      staff_id: "91a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      session_version: 1,
    });
    cache.bind(second, authorityFor(second));
    assert.equal(cache.resume(), null);
    assert.equal(await cache.get(first, orderListInput), null);
    cache.clear();
    assert.equal(cache.resume(), null);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("online binding and projection persist once and retain other committed query keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-combined-"));
  let writes = 0;
  const storage = {
    ...safeStorage,
    encryptString: (value: string) => {
      writes += 1;
      return safeStorage.encryptString(value);
    },
  };
  const now = () => new Date("2026-07-30T01:00:00.000Z");
  const session = sessionOf();
  const second = { name: "order.list", body: { status: "closed", limit: 20 } };
  try {
    const cache = createCache(root, now, storage);
    assert.equal(
      await cache.bindAndPut(
        session,
        authorityFor(session),
        orderListInput,
        orderListResult,
        () => true,
      ),
      true,
    );
    assert.equal(writes, 1);
    // Another instance's completed write must be visible; no decrypted in-memory snapshot.
    const other = createCache(root, now, storage);
    assert.equal(
      await other.bindAndPut(session, authorityFor(session), second, orderListResult, () => true),
      true,
    );
    assert.equal(writes, 2);
    const third = { name: "order.list", body: { status: "open", limit: 10 } };
    assert.equal(
      await cache.bindAndPut(session, authorityFor(session), third, orderListResult, () => true),
      true,
    );
    assert.equal(writes, 3);
    const reopened = createCache(root, now);
    assert.equal(reopened.resume()?.cachedQueryCount, 3);
    for (const input of [orderListInput, second, third])
      assert.deepEqual(await reopened.get(session, input), orderListResult);
    assert.doesNotMatch(
      await readFile(join(root, "offline-read-cache.json"), "utf8"),
      /order\.list|13800000001|offline_grant/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uncacheable online results still refresh full session, grant and clock checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-bound-"));
  let nowMs = Date.parse("2026-07-30T01:00:00.000Z");
  try {
    const original = sessionOf(),
      cache = createCache(root, () => new Date(nowMs));
    await cache.bindAndPut(
      original,
      authorityFor(original),
      orderListInput,
      orderListResult,
      () => true,
    );
    const refreshed = DesktopSessionViewSchema.parse({
      ...original,
      role: "admin",
      display: { ...original.display, staff_name: "新显示名" },
      features: { member_enabled: false },
    });
    nowMs += 1_000;
    const renewed = authorityFor(refreshed, "2026-07-30T00:01:00.000Z", "2026-07-30T12:01:00.000Z");
    assert.equal(
      await cache.bindAndPut(
        refreshed,
        renewed,
        { name: "customer.duplicates", body: { customer_id: STAFF_ID } },
        orderListResult,
        () => true,
      ),
      false,
    );
    assert.deepEqual(cache.resume()?.sessionView, refreshed);
    assert.equal(cache.resume()?.grantNotAfter, "2026-07-30T12:01:00.000Z");
    nowMs += 1_000;
    const oversized = {
      ok: true,
      data: { execution: "executed", result: { blob: "x".repeat(330 * 1024) } },
    };
    assert.equal(
      await cache.bindAndPut(refreshed, renewed, orderListInput, oversized, () => true),
      false,
    );
    assert.deepEqual(await cache.get(refreshed, orderListInput), orderListResult);
    nowMs -= 500;
    await assert.rejects(
      cache.bindAndPut(refreshed, renewed, orderListInput, orderListResult, () => true),
      /wall-clock rollback/u,
    );
    assert.equal(cache.resume(), null);
    nowMs = Date.parse("2026-07-30T12:01:00.000Z");
    await assert.rejects(
      cache.bindAndPut(refreshed, renewed, orderListInput, orderListResult, () => true),
      /authority is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combined write drops old identity entries and rejects a forged grant before pinning", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-identity-"));
  const now = () => new Date("2026-07-30T01:00:00.000Z");
  try {
    const first = sessionOf(),
      cache = createCache(root, now);
    await cache.bindAndPut(first, authorityFor(first), orderListInput, orderListResult, () => true);
    const second = sessionOf({
      session_id: "81a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      staff_id: "91a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      permission_version: 4,
    });
    const nextInput = { name: "order.list", body: { status: "closed", limit: 20 } };
    await cache.bindAndPut(second, authorityFor(second), nextInput, orderListResult, () => true);
    assert.equal(await cache.get(first, orderListInput), null);
    assert.equal(await cache.get(second, orderListInput), null);
    assert.deepEqual(await cache.get(second, nextInput), orderListResult);
    let pinCalls = 0;
    const untrusted = new OfflineReadCache({
      rootPath: root,
      now,
      safeStorage,
      authorityTrust: {
        accept: () => {
          pinCalls += 1;
          return true;
        },
      },
    });
    const grant = authorityFor(second);
    await assert.rejects(
      untrusted.bindAndPut(
        second,
        { ...grant, offlineGrant: { ...grant.offlineGrant, sig: "A".repeat(86) } },
        nextInput,
        orderListResult,
        () => true,
      ),
      /authority is invalid/u,
    );
    assert.equal(pinCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combined writes reread tampered and deleted files and reject a linked destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-file-change-"));
  const now = () => new Date("2026-07-30T01:00:00.000Z");
  try {
    const session = sessionOf(),
      cache = createCache(root, now),
      path = join(root, "offline-read-cache.json");
    await cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => true,
    );
    const old = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(
      path,
      JSON.stringify({ ...old, auth_tag: Buffer.alloc(16).toString("base64") }),
    );
    assert.equal(await cache.get(session, orderListInput), null);
    const next = { name: "order.list", body: { status: "closed", limit: 20 } };
    await cache.bindAndPut(session, authorityFor(session), next, orderListResult, () => true);
    assert.equal(await cache.get(session, orderListInput), null);
    assert.deepEqual(await cache.get(session, next), orderListResult);
    await rm(path);
    assert.equal(cache.resume(), null);
    await cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => true,
    );
    assert.equal(await cache.get(session, next), null);
    await rm(path);
    const target = join(root, "untouched.json");
    await writeFile(target, "untouched");
    await symlink(target, path);
    await assert.rejects(
      cache.bindAndPut(session, authorityFor(session), orderListInput, orderListResult, () => true),
      /Invalid offline read cache/u,
    );
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combined writes cannot repopulate after logout during schema parsing or before commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-stale-"));
  try {
    const session = sessionOf(),
      cache = createCache(root, () => new Date("2026-07-30T01:00:00.000Z"));
    await cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => true,
    );
    let active = true;
    const pending = cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => active,
    );
    active = false;
    cache.clear();
    assert.equal(await pending, false);
    assert.equal(cache.resume(), null);
    let calls = 0;
    assert.equal(
      await cache.bindAndPut(
        session,
        authorityFor(session),
        orderListInput,
        orderListResult,
        () => ++calls === 1,
      ),
      false,
    );
    assert.equal(calls, 2);
    assert.equal(cache.resume(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switching identity keeps a future checkpoint and does not cache a rolled-back query", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-switch-clock-"));
  let nowMs = Date.parse("2026-07-30T02:00:00.000Z");
  try {
    const cache = createCache(root, () => new Date(nowMs)),
      first = sessionOf();
    await cache.bindAndPut(first, authorityFor(first), orderListInput, orderListResult, () => true);
    nowMs -= 60_000;
    const next = sessionOf({
      session_id: "81a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      staff_id: "91a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    });
    assert.equal(
      await cache.bindAndPut(next, authorityFor(next), orderListInput, orderListResult, () => true),
      false,
    );
    assert.equal(cache.resume(), null);
    nowMs += 30_000;
    await assert.rejects(
      cache.bindAndPut(next, authorityFor(next), orderListInput, orderListResult, () => true),
      /wall-clock rollback/u,
    );
    nowMs += 30_000;
    assert.equal(
      await cache.bindAndPut(next, authorityFor(next), orderListInput, orderListResult, () => true),
      true,
    );
    assert.equal(await cache.get(first, orderListInput), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed combined encryption preserves the prior protected cache and permits recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-write-failure-"));
  let failed = false;
  const storage = {
    ...safeStorage,
    encryptString: (text: string) => {
      if (failed) throw new Error("Synthetic OS storage error");
      return safeStorage.encryptString(text);
    },
  };
  try {
    const session = sessionOf(),
      now = () => new Date("2026-07-30T01:00:00.000Z"),
      cache = createCache(root, now, storage);
    await cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => true,
    );
    const path = join(root, "offline-read-cache.json"),
      prior = await readFile(path);
    const next = { name: "order.list", body: { status: "closed", limit: 20 } };
    failed = true;
    await assert.rejects(
      cache.bindAndPut(session, authorityFor(session), next, orderListResult, () => true),
      /Synthetic OS storage error/u,
    );
    assert.deepEqual(await readFile(path), prior);
    failed = false;
    assert.deepEqual(await cache.get(session, orderListInput), orderListResult);
    assert.equal(await cache.get(session, next), null);
    assert.equal(
      await cache.bindAndPut(session, authorityFor(session), next, orderListResult, () => true),
      true,
    );
    assert.deepEqual(await createCache(root, now).get(session, next), orderListResult);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a full query cache evicts its oldest entry while persisting the renewed grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-capacity-"));
  let nowMs = Date.parse("2026-07-30T01:00:00.000Z");
  const inputAt = (offset: number) => ({
    name: "order.list",
    body: { status: "open", offset, limit: 20 },
  });
  try {
    const session = sessionOf(),
      cache = createCache(root, () => new Date(nowMs));
    for (let index = 0; index < 128; index += 1) {
      nowMs += 1;
      assert.equal(
        await cache.bindAndPut(
          session,
          authorityFor(session),
          inputAt(index),
          orderListResult,
          () => true,
        ),
        true,
      );
    }
    nowMs += 1;
    const renewed = authorityFor(session, "2026-07-30T00:01:00.000Z", "2026-07-30T12:01:00.000Z");
    assert.equal(
      await cache.bindAndPut(session, renewed, inputAt(128), orderListResult, () => true),
      true,
    );
    const resumed = createCache(root, () => new Date(nowMs)).resume();
    assert.equal(resumed?.cachedQueryCount, 128);
    assert.equal(resumed?.grantNotAfter, "2026-07-30T12:01:00.000Z");
    assert.equal(await cache.get(session, inputAt(0)), null);
    assert.deepEqual(await cache.get(session, inputAt(1)), orderListResult);
    assert.deepEqual(await cache.get(session, inputAt(128)), orderListResult);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
