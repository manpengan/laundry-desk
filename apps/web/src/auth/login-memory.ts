/**
 * Device-local memory of the last successful 机构 / 门店代码 so a single-store
 * counter only types its own account. Never stores usernames or passwords.
 */

export const LOGIN_MEMORY_KEY = "ld.login.workspace";

const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

export type LoginWorkspace = Readonly<{ org_code: string; store_code: string }>;

type MemoryStorage = Pick<Storage, "getItem" | "setItem">;

export function browserLoginStorage(): MemoryStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseLoginWorkspace(raw: string | null): LoginWorkspace | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const org = record.org_code;
    const store = record.store_code;
    if (typeof org !== "string" || typeof store !== "string") return null;
    if (!CODE.test(org) || !CODE.test(store)) return null;
    return Object.freeze({ org_code: org, store_code: store });
  } catch {
    return null;
  }
}

export function readLoginWorkspace(storage: MemoryStorage | null): LoginWorkspace | null {
  if (storage === null) return null;
  try {
    return parseLoginWorkspace(storage.getItem(LOGIN_MEMORY_KEY));
  } catch {
    return null;
  }
}

export function rememberLoginWorkspace(
  storage: MemoryStorage | null,
  workspace: LoginWorkspace,
): void {
  if (storage === null) return;
  const org = workspace.org_code.trim();
  const store = workspace.store_code.trim();
  if (!CODE.test(org) || !CODE.test(store)) return;
  try {
    storage.setItem(LOGIN_MEMORY_KEY, JSON.stringify({ org_code: org, store_code: store }));
  } catch {
    // Remembering is a convenience; a blocked store must not fail the login.
  }
}
