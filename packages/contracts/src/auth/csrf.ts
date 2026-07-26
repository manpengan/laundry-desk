import { z } from "zod";

import { snapshotPlainData } from "./plain-data.js";

export const CSRF_COOKIE_NAME = "__Host-laundry_csrf" as const;
export const CSRF_HEADER_NAME = "x-csrf-token" as const;

export const CSRF_COOKIE_DESCRIPTOR = Object.freeze({
  name: CSRF_COOKIE_NAME,
  secure: true as const,
  http_only: false as const,
  same_site: "strict" as const,
  path: "/" as const,
});

export const CSRF_COOKIE_CLEAR_DESCRIPTOR = Object.freeze({
  ...CSRF_COOKIE_DESCRIPTOR,
  max_age_seconds: 0 as const,
});

export const CsrfProofSchema = z
  .string()
  .regex(/^v1\.[A-Za-z0-9_-]{43,128}$/u, "Invalid CSRF proof format");

const CsrfTransportProofsSchema = z.strictObject({
  cookie_token: CsrfProofSchema,
  header_token: CsrfProofSchema,
});

const FetchSiteSchema = z.enum(["same-origin", "same-site", "cross-site", "none"]);
const CsrfMethodSchema = z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

const BrowserCsrfSurfaceSchema = z.strictObject({
  kind: z.literal("browser"),
  fetch_site: FetchSiteSchema,
});

const TrustedDesktopCsrfSurfaceSchema = z.strictObject({
  kind: z.literal("trusted-desktop"),
  fetch_site: z.literal("none"),
});

const UntrustedCsrfSurfaceSchema = z.strictObject({
  kind: z.literal("untrusted"),
});

/**
 * Server-owned surface classification. The trusted-desktop variant may be constructed only
 * after the local request-security boundary matched the exact desktop Origin + Fetch-Site pair.
 */
export const CsrfRequestSurfaceSchema = z
  .discriminatedUnion("kind", [
    BrowserCsrfSurfaceSchema,
    TrustedDesktopCsrfSurfaceSchema,
    UntrustedCsrfSurfaceSchema,
  ])
  .readonly();

export type CsrfRequestSurface = z.output<typeof CsrfRequestSurfaceSchema>;

const CsrfRequestFactsSchema = z.strictObject({
  method: CsrfMethodSchema,
  surface: CsrfRequestSurfaceSchema,
  cookie_present: z.boolean(),
  header_present: z.boolean(),
  tokens_match: z.boolean(),
  proof_valid: z.boolean(),
});

const LoginPreAuthOriginFactsSchema = z.strictObject({
  method: z.literal("POST"),
  surface: CsrfRequestSurfaceSchema,
});

export const CsrfRejectionReasonSchema = z.enum([
  "ORIGIN_NOT_ALLOWED",
  "FETCH_METADATA_REJECTED",
  "TOKEN_MISSING",
  "TOKEN_MISMATCH",
  "PROOF_INVALID",
]);

export type CsrfRejectionReason = z.output<typeof CsrfRejectionReasonSchema>;

export type CsrfDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: CsrfRejectionReason }>;

const ALLOWED = Object.freeze({ allowed: true as const });
const VALID_TRANSPORT_PROOFS = Object.freeze({ valid: true as const });

const parseSnapshot = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> => schema.parse(snapshotPlainData(input, label));

const reject = (reason: CsrfRejectionReason): CsrfDecision =>
  Object.freeze({ allowed: false as const, reason });

const isSafeMethod = (method: z.output<typeof CsrfMethodSchema>): boolean =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

const rejectSurface = (surface: CsrfRequestSurface): CsrfDecision | null => {
  if (surface.kind === "untrusted") return reject("ORIGIN_NOT_ALLOWED");
  if (
    surface.kind === "browser" &&
    surface.fetch_site !== "same-origin" &&
    surface.fetch_site !== "same-site"
  ) {
    return reject("FETCH_METADATA_REJECTED");
  }
  return null;
};

/**
 * Validates cookie and header proof syntax independently. It neither compares the values nor
 * returns them; C6 owns constant-time comparison and MAC/session binding.
 */
export const validateCsrfTransportProofs = (input: unknown): Readonly<{ valid: true }> => {
  parseSnapshot(CsrfTransportProofsSchema, input, "CSRF transport proofs");
  return VALID_TRANSPORT_PROOFS;
};

/** Evaluates requests for which the operation matrix requires the full CSRF contract. */
export const evaluateCsrfRequest = (input: unknown): CsrfDecision => {
  const facts = parseSnapshot(CsrfRequestFactsSchema, input, "CSRF request facts");
  if (isSafeMethod(facts.method)) return ALLOWED;
  const surfaceRejection = rejectSurface(facts.surface);
  if (surfaceRejection !== null) return surfaceRejection;
  if (!facts.cookie_present || !facts.header_present) return reject("TOKEN_MISSING");
  if (!facts.tokens_match) return reject("TOKEN_MISMATCH");
  if (!facts.proof_valid) return reject("PROOF_INVALID");
  return ALLOWED;
};

/**
 * Evaluates only login's pre-auth Origin/Fetch Metadata gate. Task 5's operation matrix is the
 * authority that limits this exemption to login; refresh, logout and commands use the full gate.
 */
export const evaluateLoginPreAuthOrigin = (input: unknown): CsrfDecision => {
  const facts = parseSnapshot(LoginPreAuthOriginFactsSchema, input, "login pre-auth origin facts");
  const surfaceRejection = rejectSurface(facts.surface);
  if (surfaceRejection !== null) return surfaceRejection;
  return ALLOWED;
};
