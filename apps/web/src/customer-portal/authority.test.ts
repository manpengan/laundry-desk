import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY,
  createCustomerPortalAuthorityStore,
  customerPortalCookieSelector,
  type CustomerPortalAuthorityStorageBackend,
} from "./authority.js";
import { createCustomerPortalTabLockCoordinator } from "./authority-lock.js";

type LockCallback = (lock: Readonly<{ name: string }> | null) => Promise<void>;

function fakeLockManager() {
  let locked: ReadonlySet<string> = new Set();
  return Object.freeze({
    async request(
      name: string,
      _options: Readonly<{ ifAvailable: true; mode: "exclusive" }>,
      callback: LockCallback,
    ): Promise<void> {
      if (locked.has(name)) {
        await callback(null);
        return;
      }
      locked = new Set(locked).add(name);
      try {
        await callback(Object.freeze({ name }));
      } finally {
        const next = new Set(locked);
        next.delete(name);
        locked = next;
      }
    },
  });
}

function memoryStorage(
  initial?: ReadonlyMap<string, string>,
): CustomerPortalAuthorityStorageBackend {
  let entries: ReadonlyMap<string, string> = new Map(initial);
  return Object.freeze({
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries = new Map(entries).set(key, value);
    },
    removeItem: (key: string) => {
      const next = new Map(entries);
      next.delete(key);
      entries = next;
    },
  });
}

const fill =
  (seed: number) =>
  (bytes: Uint8Array): void => {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed + index;
  };

test("tab authority is 256-bit, reload-stable in one sessionStorage and isolated by tab", async () => {
  const manager = fakeLockManager();
  const tabAStorage = memoryStorage();
  const tabBStorage = memoryStorage();
  const tabA = createCustomerPortalAuthorityStore({
    storage: tabAStorage,
    fillRandom: fill(1),
    instanceNonce: "instance-a",
    coordinator: createCustomerPortalTabLockCoordinator(manager),
  });
  const authorityA = await tabA.issue();
  assert.match(authorityA ?? "", /^v1\.[A-Za-z0-9_-]{43}$/u);
  tabA.dispose();
  await Promise.resolve();
  assert.equal(
    await createCustomerPortalAuthorityStore({
      storage: tabAStorage,
      instanceNonce: "instance-a-reload",
      coordinator: createCustomerPortalTabLockCoordinator(manager),
    }).claimCurrent(),
    authorityA,
    "reload in the same tab must resume with its sessionStorage authority",
  );
  const tabB = createCustomerPortalAuthorityStore({
    storage: tabBStorage,
    fillRandom: fill(2),
    instanceNonce: "instance-b",
    coordinator: createCustomerPortalTabLockCoordinator(manager),
  });
  assert.equal(tabB.current(), null, "a fresh tab must not inherit another tab authority");
  const authorityB = await tabB.issue();
  assert.notEqual(authorityB, authorityA);
  assert.equal(tabBStorage.getItem(CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY), authorityB);
});

test("authority clearing is compare-and-remove so an old response cannot erase a newer login", async () => {
  const manager = fakeLockManager();
  const storage = memoryStorage();
  let seed = 3;
  const first = createCustomerPortalAuthorityStore({
    storage,
    fillRandom: (bytes) => fill(seed++)(bytes),
    instanceNonce: "instance-c",
    coordinator: createCustomerPortalTabLockCoordinator(manager),
  });
  const oldAuthority = await first.issue();
  assert.ok(oldAuthority);
  const currentAuthority = await first.issue();
  assert.ok(currentAuthority);
  first.clear(oldAuthority);
  assert.equal(first.current(), currentAuthority);
  first.clear(currentAuthority);
  assert.equal(first.current(), null);
});

test("duplicate tabs cannot share a copied authority or cookie selector", async () => {
  const authority = `v1.${"z".repeat(43)}`;
  const initial = new Map([[CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY, authority]]);
  const manager = fakeLockManager();
  const tabA = createCustomerPortalAuthorityStore({
    storage: memoryStorage(initial),
    fillRandom: fill(5),
    instanceNonce: "duplicate-a",
    coordinator: createCustomerPortalTabLockCoordinator(manager),
  });
  const tabB = createCustomerPortalAuthorityStore({
    storage: memoryStorage(initial),
    fillRandom: fill(6),
    instanceNonce: "duplicate-b",
    coordinator: createCustomerPortalTabLockCoordinator(manager),
  });

  const claims = await Promise.all([tabA.claimCurrent(), tabB.claimCurrent()]);
  assert.equal(claims.filter((value) => value === authority).length, 1);
  const winner = claims[0] === authority ? tabA : tabB;
  const loser = winner === tabA ? tabB : tabA;
  assert.equal(loser.current(), null, "the copied tab must fail closed");
  const replacement = await loser.issue();
  assert.ok(replacement);
  assert.notEqual(replacement, authority);
  assert.notEqual(
    await customerPortalCookieSelector(replacement),
    await customerPortalCookieSelector(authority),
  );
  winner.clear(authority);
  loser.clear(replacement);
});

test("missing browser lock authority fails closed and removes the copied proof", async () => {
  const authority = `v1.${"y".repeat(43)}`;
  const storage = memoryStorage(new Map([[CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY, authority]]));
  const store = createCustomerPortalAuthorityStore({
    storage,
    fillRandom: fill(7),
    instanceNonce: "no-locks",
    coordinator: createCustomerPortalTabLockCoordinator(null),
  });
  assert.equal(await store.claimCurrent(), null);
  assert.equal(storage.getItem(CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY), null);
  assert.equal(await store.issue(), null);
  assert.equal(store.current(), null);
});

test("cookie selector is a one-way SHA-256 projection and never embeds tab authority", async () => {
  const authority = `v1.${"a".repeat(43)}`;
  const selector = await customerPortalCookieSelector(authority);
  assert.equal(selector, "4JTmFDNpK4VrlEIfOPnfGXbs5hq7DHpCNHMwcmLW2MA");
  assert.equal(selector?.includes(authority.slice(3)), false);
  assert.equal(await customerPortalCookieSelector("invalid"), null);
});
