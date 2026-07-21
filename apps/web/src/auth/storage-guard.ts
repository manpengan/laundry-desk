/**
 * Access tokens must never land in Web Storage (A5 / ADR-11).
 * Helpers used by tests and defensive runtime checks.
 */

const SECRET_KEY_RE = /access_token|refresh_token|auth_token|session_token|csrf/iu;

function storageHasSecrets(storage: Storage | undefined): boolean {
  if (!storage) return false;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null) continue;
      if (SECRET_KEY_RE.test(key)) return true;
      const value = storage.getItem(key);
      if (value !== null && SECRET_KEY_RE.test(value)) return true;
    }
  } catch {
    // Storage may throw in privacy modes — treat as "no secrets readable".
    return false;
  }
  return false;
}

export function webStorageHasAuthSecrets(): boolean {
  if (typeof globalThis === "undefined") return false;
  const g = globalThis as typeof globalThis & {
    localStorage?: Storage;
    sessionStorage?: Storage;
  };
  return storageHasSecrets(g.localStorage) || storageHasSecrets(g.sessionStorage);
}

/** Assert helper for unit tests after auth flows. */
export function assertNoAuthSecretsInWebStorage(): void {
  if (webStorageHasAuthSecrets()) {
    throw new Error("Auth secrets must not be written to Web Storage");
  }
}
