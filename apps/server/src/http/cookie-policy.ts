/**
 * Auth cookie policy derived from @laundry/contracts A5 descriptors.
 *
 * Production / HTTPS: exact contract names (`__Host-laundry_*`), Secure, SameSite=Strict.
 * Local HTTP (Vite + Fastify on loopback): drop `__Host-` prefix and Secure so browsers
 * accept cookies without TLS. SameSite defaults to Strict (same-site cross-port still works).
 */

import {
  CSRF_COOKIE_DESCRIPTOR,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_DESCRIPTOR,
} from "@laundry/contracts";

export type CookiePolicy = Readonly<{
  refreshName: string;
  csrfName: string;
  secure: boolean;
  httpOnlyRefresh: true;
  httpOnlyCsrf: false;
  sameSite: "strict" | "lax";
  path: "/";
  refreshMaxAgeSeconds: number;
}>;

export type CookiePolicyInput = Readonly<{
  /**
   * Force Secure + __Host- names. Runtime composition roots should pass this
   * directly; environment parsing remains available only for explicit deployment
   * configuration.
   */
  secure?: boolean;
  env?: NodeJS.ProcessEnv;
}>;

function stripHostPrefix(name: string): string {
  return name.startsWith("__Host-") ? name.slice("__Host-".length) : name;
}

export function resolveCookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.LAUNDRY_COOKIE_SECURE?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  if (flag === undefined || flag.length === 0) {
    throw new Error("LAUNDRY_COOKIE_SECURE must be explicitly configured");
  }
  throw new Error("LAUNDRY_COOKIE_SECURE must be 0, 1, false, or true");
}

/**
 * Resolve cookie names + flags. Contract descriptors remain the production source of truth.
 */
export function resolveCookiePolicy(input: CookiePolicyInput = {}): CookiePolicy {
  const env = input.env ?? process.env;
  const secure = input.secure ?? resolveCookieSecure(env);

  const contractRefresh = REFRESH_COOKIE_DESCRIPTOR.name;
  const contractCsrf = CSRF_COOKIE_NAME;

  return Object.freeze({
    refreshName: secure ? contractRefresh : stripHostPrefix(contractRefresh),
    csrfName: secure ? contractCsrf : stripHostPrefix(contractCsrf),
    secure,
    httpOnlyRefresh: true as const,
    httpOnlyCsrf: false as const,
    // Strict matches contracts; same-site (different ports on 127.0.0.1) still sends cookies.
    sameSite: CSRF_COOKIE_DESCRIPTOR.same_site,
    path: "/" as const,
    refreshMaxAgeSeconds: REFRESH_COOKIE_DESCRIPTOR.max_age_seconds,
  });
}

/** Fastify setCookie options for refresh secret. */
export function refreshCookieOptions(policy: CookiePolicy): Readonly<{
  httpOnly: true;
  sameSite: "strict" | "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}> {
  return Object.freeze({
    httpOnly: true as const,
    sameSite: policy.sameSite,
    path: policy.path,
    secure: policy.secure,
    maxAge: policy.refreshMaxAgeSeconds,
  });
}

/** Fastify setCookie options for readable CSRF double-submit token. */
export function csrfCookieOptions(policy: CookiePolicy): Readonly<{
  httpOnly: false;
  sameSite: "strict" | "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}> {
  return Object.freeze({
    httpOnly: false as const,
    sameSite: policy.sameSite,
    path: policy.path,
    secure: policy.secure,
    maxAge: policy.refreshMaxAgeSeconds,
  });
}

type CookieClearOptions<HttpOnly extends boolean> = Readonly<{
  httpOnly: HttpOnly;
  sameSite: "strict" | "lax";
  path: "/";
  secure: boolean;
  maxAge: 0;
}>;

function cookieClearOptions<HttpOnly extends boolean>(
  policy: CookiePolicy,
  httpOnly: HttpOnly,
): CookieClearOptions<HttpOnly> {
  return Object.freeze({
    httpOnly,
    sameSite: policy.sameSite,
    path: policy.path,
    secure: policy.secure,
    maxAge: 0 as const,
  });
}

/** Clear refresh with the same host/path/security attributes used at issuance. */
export function refreshCookieClearOptions(policy: CookiePolicy): CookieClearOptions<true> {
  return cookieClearOptions(policy, true);
}

/** Clear CSRF with the same host/path/security attributes used at issuance. */
export function csrfCookieClearOptions(policy: CookiePolicy): CookieClearOptions<false> {
  return cookieClearOptions(policy, false);
}
