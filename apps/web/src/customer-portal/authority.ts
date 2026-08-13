import { CustomerPortalAuthoritySchema } from "@laundry/contracts";

import {
  createCustomerPortalTabLockCoordinator,
  type CustomerPortalTabLockCoordinator,
} from "./authority-lock.js";

export const CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY =
  "laundry.customer-portal.tab-authority.v1" as const;

export type CustomerPortalAuthorityStorageBackend = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}>;

export type CustomerPortalAuthorityStore = Readonly<{
  claimCurrent(): Promise<string | null>;
  current(): string | null;
  issue(): Promise<string | null>;
  clear(expected: string): void;
  dispose(): void;
}>;

type AuthorityStoreOptions = Readonly<{
  storage?: CustomerPortalAuthorityStorageBackend | null;
  fillRandom?: (bytes: Uint8Array) => void;
  coordinator?: CustomerPortalTabLockCoordinator;
  instanceNonce?: string;
}>;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET.charAt(first >>> 2);
    encoded += BASE64URL_ALPHABET.charAt(((first & 3) << 4) | ((second ?? 0) >>> 4));
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET.charAt(((second & 15) << 2) | ((third ?? 0) >>> 6));
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET.charAt(third & 63);
  }
  return encoded;
}

function browserSessionStorage(): CustomerPortalAuthorityStorageBackend | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function systemFillRandom(bytes: Uint8Array): void {
  globalThis.crypto.getRandomValues(bytes);
}

function randomToken(fillRandom: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(32);
  fillRandom(bytes);
  return base64Url(bytes);
}

export async function customerPortalCookieSelector(authority: string): Promise<string | null> {
  if (!CustomerPortalAuthoritySchema.safeParse(authority).success) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(authority),
    );
    return base64Url(new Uint8Array(digest));
  } catch {
    return null;
  }
}

export function createCustomerPortalAuthorityStore(
  options: AuthorityStoreOptions = {},
): CustomerPortalAuthorityStore {
  const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
  const fillRandom = options.fillRandom ?? systemFillRandom;
  const coordinator = options.coordinator ?? createCustomerPortalTabLockCoordinator();
  const instanceNonce = options.instanceNonce ?? randomToken(fillRandom);
  let claimed: Readonly<{ authority: string; lockName: string }> | null = null;
  let disposed = false;
  let mutationQueue: Promise<void> = Promise.resolve();

  const stored = (): string | null => {
    if (storage === null) return null;
    try {
      const value = storage.getItem(CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY);
      return CustomerPortalAuthoritySchema.safeParse(value).success ? value : null;
    } catch {
      return null;
    }
  };

  const removeStored = (expected: string): void => {
    if (storage === null) return;
    try {
      if (stored() === expected) storage.removeItem(CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY);
    } catch {
      // Storage denial is already a fail-closed state.
    }
  };

  const releaseClaim = (expected: string, remove: boolean): void => {
    if (claimed?.authority !== expected) return;
    coordinator.release(claimed.lockName, instanceNonce);
    claimed = null;
    if (remove) removeStored(expected);
  };

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    let releaseQueue = (): void => undefined;
    mutationQueue = new Promise<void>((release) => {
      releaseQueue = release;
    });
    await previous;
    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  };

  const claim = async (authority: string): Promise<string | null> => {
    const selector = await customerPortalCookieSelector(authority);
    if (selector === null) return null;
    const lockName = `laundry.customer-portal.authority.${selector}`;
    if (!(await coordinator.claim(lockName, instanceNonce))) return null;
    if (disposed || stored() !== authority) {
      coordinator.release(lockName, instanceNonce);
      return null;
    }
    claimed = Object.freeze({ authority, lockName });
    return authority;
  };

  const claimCurrent = (): Promise<string | null> =>
    serialized(async () => {
      if (disposed || storage === null) return null;
      const authority = stored();
      if (authority === null) return null;
      if (claimed?.authority === authority) return authority;
      if (claimed !== null) releaseClaim(claimed.authority, false);
      const result = await claim(authority);
      if (result === null) removeStored(authority);
      return result;
    });

  const issue = (): Promise<string | null> =>
    serialized(async () => {
      if (disposed || storage === null) return null;
      if (claimed !== null) releaseClaim(claimed.authority, true);
      const bytes = new Uint8Array(32);
      fillRandom(bytes);
      const authority = `v1.${base64Url(bytes)}`;
      if (!CustomerPortalAuthoritySchema.safeParse(authority).success) return null;
      try {
        storage.setItem(CUSTOMER_PORTAL_AUTHORITY_STORAGE_KEY, authority);
      } catch {
        return null;
      }
      const result = await claim(authority);
      if (result === null) removeStored(authority);
      return result;
    });

  const current = (): string | null => claimed?.authority ?? null;

  const clear = (expected: string): void => releaseClaim(expected, true);

  const dispose = (): void => {
    disposed = true;
    if (claimed !== null) releaseClaim(claimed.authority, false);
  };

  return Object.freeze({ claimCurrent, current, issue, clear, dispose });
}
