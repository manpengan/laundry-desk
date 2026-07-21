/**
 * C8 CSRF double-submit check — pure function aligned with contracts CSRF names.
 * Constant-time token comparison is performed here; contracts evaluate structural facts.
 */

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  evaluateCsrfRequest,
  type CsrfDecision,
  type CsrfRejectionReason,
} from "@laundry/contracts";

import { constantTimeEqual } from "../identity/crypto-util.js";
import { AuthError } from "./context.js";

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };

export type CsrfCheckInput = Readonly<{
  method: "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
  origin_allowed: boolean;
  fetch_site: "same-origin" | "same-site" | "cross-site" | "none";
  /** Raw CSRF cookie value (readable; not HttpOnly). */
  cookie_token: string | null | undefined;
  /** Header value under CSRF_HEADER_NAME (`x-csrf-token`). */
  header_token: string | null | undefined;
}>;

export type CsrfCheckResult =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: CsrfRejectionReason }>;

const present = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Double-submit CSRF gate for unsafe methods.
 * Safe methods (GET/HEAD/OPTIONS) pass without tokens (contracts evaluateCsrfRequest).
 */
export const checkCsrfDoubleSubmit = (input: CsrfCheckInput): CsrfCheckResult => {
  const cookiePresent = present(input.cookie_token);
  const headerPresent = present(input.header_token);
  const tokensMatch =
    cookiePresent && headerPresent && constantTimeEqual(input.cookie_token, input.header_token);

  // Transport syntax is validated inside evaluateCsrfRequest via proof_valid fact.
  // We treat malformed tokens as proof_valid=false when present but non-matching schema
  // is approximated: empty → missing; present but unequal → mismatch; both equal → valid.
  let proofValid = false;
  if (tokensMatch && cookiePresent && headerPresent) {
    // contracts CsrfProofSchema: v1.[A-Za-z0-9_-]{43,128}
    proofValid = /^v1\.[A-Za-z0-9_-]{43,128}$/u.test(input.cookie_token);
  }

  const decision: CsrfDecision = evaluateCsrfRequest({
    method: input.method,
    origin_allowed: input.origin_allowed,
    fetch_site: input.fetch_site,
    cookie_present: cookiePresent,
    header_present: headerPresent,
    tokens_match: tokensMatch,
    proof_valid: proofValid,
  });

  if (decision.allowed) {
    return Object.freeze({ allowed: true as const });
  }
  return Object.freeze({ allowed: false as const, reason: decision.reason });
};

/** Throws AuthError when CSRF is required and fails (unsafe ops). */
export const assertCsrf = (input: CsrfCheckInput): void => {
  const result = checkCsrfDoubleSubmit(input);
  if (!result.allowed) {
    throw new AuthError("CSRF_REJECTED", result.reason);
  }
};

/**
 * Extract CSRF material from a header map (case-insensitive lookup for header name).
 */
export const readCsrfHeader = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const direct = headers[CSRF_HEADER_NAME];
  if (direct !== undefined) return direct;
  const lower = CSRF_HEADER_NAME.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};
