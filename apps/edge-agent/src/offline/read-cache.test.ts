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
