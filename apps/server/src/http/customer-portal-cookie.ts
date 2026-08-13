import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { CSRF_HEADER_NAME, customerPortalCookieNames } from "@laundry/contracts";

import type { CustomerPortalSessionIdentity } from "../customer-self-service/index.js";
import type { CookiePolicy } from "./cookie-policy.js";

const SESSION_TTL_SECONDS = 15 * 60;

function cookieOptions(policy: CookiePolicy, httpOnly: boolean, maxAge: number) {
  return Object.freeze({
    httpOnly,
    sameSite: policy.sameSite,
    path: policy.path,
    secure: policy.secure,
    maxAge,
  });
}

function names(authority: string, policy: CookiePolicy) {
  const selector = createHash("sha256").update(authority, "utf8").digest("base64url");
  return customerPortalCookieNames(selector, policy.secure);
}

export const hashCustomerPortalSecret = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex");

export function customerPortalHashMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashCustomerPortalSecret(secret), "ascii");
  const expected = Buffer.from(expectedHash, "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function setCustomerPortalCookies(
  reply: FastifyReply,
  policy: CookiePolicy,
  authority: string,
  sessionSecret: string,
  csrfSecret: string,
): void {
  const selected = names(authority, policy);
  if (selected === null) throw new TypeError("Invalid customer portal tab authority");
  reply.setCookie(
    selected.session,
    sessionSecret,
    cookieOptions(policy, true, SESSION_TTL_SECONDS),
  );
  reply.setCookie(selected.csrf, csrfSecret, cookieOptions(policy, false, SESSION_TTL_SECONDS));
}

export function clearCustomerPortalCookies(
  reply: FastifyReply,
  policy: CookiePolicy,
  authority: string,
): void {
  const selected = names(authority, policy);
  if (selected === null) return;
  reply.clearCookie(selected.session, cookieOptions(policy, true, 0));
  reply.clearCookie(selected.csrf, cookieOptions(policy, false, 0));
}

export function customerPortalSessionSecret(
  request: FastifyRequest,
  policy: CookiePolicy,
  authority: string,
): string | null {
  const selected = names(authority, policy);
  if (selected === null) return null;
  const secret = request.cookies[selected.session];
  return typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/u.test(secret) ? secret : null;
}

export function customerPortalCsrfAllowed(
  request: FastifyRequest,
  policy: CookiePolicy,
  authority: string,
  identity: CustomerPortalSessionIdentity,
): boolean {
  const selected = names(authority, policy);
  if (selected === null) return false;
  const header = request.headers[CSRF_HEADER_NAME.toLowerCase()];
  const cookie = request.cookies[selected.csrf];
  return (
    typeof header === "string" &&
    typeof cookie === "string" &&
    header.length > 0 &&
    header === cookie &&
    customerPortalHashMatches(header, identity.csrfHash)
  );
}

export function setCustomerPortalNoStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
