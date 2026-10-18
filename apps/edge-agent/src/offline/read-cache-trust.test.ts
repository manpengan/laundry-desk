import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafeStorageAuthorityTrustStore } from "../pairing/authority-trust.js";
import { OfflineReadCache } from "./read-cache.js";
import {
  authorityFor,
  orderListInput,
  orderListResult,
  safeStorage,
  sessionOf,
} from "./read-cache-fixture.js";

test("combined writes sample grant expiry after reading the prior cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-read-expiry-"));
  let nowMs = Date.parse("2026-07-30T01:00:00.000Z");
  let expireOnRead = false;
  try {
    const session = sessionOf();
    const cache = new OfflineReadCache({
      rootPath: root,
      now: () => new Date(nowMs),
      authorityTrust: { accept: () => true },
      safeStorage: {
        ...safeStorage,
        decryptString: (bytes) => {
          if (expireOnRead) nowMs = Date.parse("2026-07-30T12:00:00.000Z");
          return safeStorage.decryptString(bytes);
        },
      },
    });
    await cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => true,
    );
    const path = join(root, "offline-read-cache.json");
    const previous = await readFile(path);
    expireOnRead = true;
    await assert.rejects(
      cache.bindAndPut(session, authorityFor(session), orderListInput, orderListResult, () => true),
      /authority is invalid/u,
    );
    assert.deepEqual(await readFile(path), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const change of ["fingerprint", "permissions"] as const) {
  test(
    `combined writes re-read changed disk trust ${change} on the next request`,
    { skip: change === "permissions" && process.platform === "win32" },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "laundry-cache-disk-trust-"));
      try {
        const session = sessionOf();
        const trustRoot = join(root, "trust");
        const cache = new OfflineReadCache({
          rootPath: join(root, "cache"),
          safeStorage,
          now: () => new Date("2026-07-30T01:00:00.000Z"),
          authorityTrust: new SafeStorageAuthorityTrustStore(trustRoot, safeStorage),
        });
        await cache.bindAndPut(
          session,
          authorityFor(session),
          orderListInput,
          orderListResult,
          () => true,
        );
        const path = join(root, "cache", "offline-read-cache.json");
        const previous = await readFile(path);
        const trustPath = join(trustRoot, "authority-trust.json");
        if (change === "permissions") await chmod(trustPath, 0o644);
        else
          await writeFile(
            trustPath,
            JSON.stringify({
              version: 1,
              protected_fingerprint: safeStorage
                .encryptString(Buffer.alloc(32).toString("base64"))
                .toString("base64"),
            }),
          );
        await assert.rejects(
          cache.bindAndPut(
            session,
            authorityFor(session),
            orderListInput,
            orderListResult,
            () => true,
          ),
          /authority is invalid/u,
        );
        assert.deepEqual(await readFile(path), previous);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("combined writes verify fresh trust once per request and fail after trust is revoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-fresh-trust-"));
  let accepted = true;
  let calls = 0;
  try {
    const session = sessionOf();
    const cache = new OfflineReadCache({
      rootPath: root,
      safeStorage,
      now: () => new Date("2026-07-30T01:00:00.000Z"),
      authorityTrust: {
        accept: () => {
          calls += 1;
          return accepted;
        },
      },
    });
    for (let index = 1; index <= 2; index += 1) {
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
      assert.equal(calls, index);
    }
    const path = join(root, "offline-read-cache.json");
    const previous = await readFile(path);
    accepted = false;
    await assert.rejects(
      cache.bindAndPut(session, authorityFor(session), orderListInput, orderListResult, () => true),
      /authority is invalid/u,
    );
    assert.equal(calls, 3);
    assert.deepEqual(await readFile(path), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combined writes check trust after decrypting the prior cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-trust-order-"));
  let revokeOnRead = false;
  let accepted = true;
  try {
    const session = sessionOf();
    const cache = new OfflineReadCache({
      rootPath: root,
      now: () => new Date("2026-07-30T01:00:00.000Z"),
      safeStorage: {
        ...safeStorage,
        decryptString: (bytes) => {
          if (revokeOnRead) accepted = false;
          return safeStorage.decryptString(bytes);
        },
      },
      authorityTrust: { accept: () => accepted },
    });
    await cache.bindAndPut(
      session,
      authorityFor(session),
      orderListInput,
      orderListResult,
      () => true,
    );
    const path = join(root, "offline-read-cache.json");
    const previous = await readFile(path);
    revokeOnRead = true;
    await assert.rejects(
      cache.bindAndPut(session, authorityFor(session), orderListInput, orderListResult, () => true),
      /authority is invalid/u,
    );
    assert.deepEqual(await readFile(path), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const changedTime of [
  "2026-07-30T12:00:00.000Z",
  "2026-07-30T00:59:59.999Z",
  "2026-07-29T23:59:59.999Z",
]) {
  test(`combined writes recheck clock after trust verification at ${changedTime}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-cache-trust-clock-"));
    const checkpoint = Date.parse("2026-07-30T01:00:00.000Z");
    let nowMs = checkpoint;
    let changeClock = false;
    try {
      const session = sessionOf();
      const cache = new OfflineReadCache({
        rootPath: root,
        safeStorage,
        now: () => new Date(nowMs),
        authorityTrust: {
          accept: () => {
            if (changeClock) nowMs = Date.parse(changedTime);
            return true;
          },
        },
      });
      nowMs = checkpoint - 1;
      await cache.bindAndPut(
        session,
        authorityFor(session),
        orderListInput,
        orderListResult,
        () => true,
      );
      nowMs = checkpoint;
      changeClock = true;
      const next = { name: "order.list", body: { status: "closed", limit: 20 } };
      assert.equal(
        await cache.bindAndPut(session, authorityFor(session), next, orderListResult, () => true),
        false,
      );
      changeClock = false;
      nowMs = checkpoint - 1;
      assert.equal(cache.resume(), null);
      nowMs = checkpoint;
      assert.equal(cache.resume()?.cachedQueryCount, 1);
      assert.equal(await cache.get(session, next), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
