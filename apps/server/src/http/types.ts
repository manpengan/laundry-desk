/**
 * Fastify request decoration for local HTTP (C8-style).
 */

import type { SessionRecord } from "../identity/types.js";
import { resolveCookiePolicy } from "./cookie-policy.js";

export type RequestAuthBinding = Readonly<{
  session: SessionRecord | null;
  refreshSecret: string | null;
  accessToken: string | null;
}>;

export type CookieNames = Readonly<{
  refresh: string;
  csrf: string;
}>;

/**
 * Default local (non-secure) cookie names — aligned with contracts after stripping `__Host-`.
 * Prefer `resolveCookiePolicy()` at runtime; this export remains for tests that only need names.
 */
export const LOCAL_COOKIE_NAMES: CookieNames = (() => {
  const policy = resolveCookiePolicy({ secure: false });
  return Object.freeze({
    refresh: policy.refreshName,
    csrf: policy.csrfName,
  });
})();

/** Production / HTTPS cookie names from contracts (`__Host-…`). */
export const SECURE_COOKIE_NAMES: CookieNames = (() => {
  const policy = resolveCookiePolicy({ secure: true });
  return Object.freeze({
    refresh: policy.refreshName,
    csrf: policy.csrfName,
  });
})();
