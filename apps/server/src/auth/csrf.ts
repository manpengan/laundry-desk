/**
 * CSRF proof signing and double-submit checks.
 *
 * Proofs are opaque, versioned, session-bound values. Contracts own their transport shape;
 * this module owns HMAC/session verification and constant-time comparisons.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CsrfProofSchema,
  evaluateCsrfRequest,
  type CsrfDecision,
  type CsrfRejectionReason,
  type CsrfRequestSurface,
} from "@laundry/contracts";

import { AuthError } from "./context.js";

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };

const CSRF_PROOF_PREFIX = "v1." as const;
const CSRF_PROOF_SECRET_MINIMUM_BYTES = 32;
const SESSION_ID_BYTES = 16;
const SESSION_VERSION_BYTES = 8;
const ROTATION_NONCE_BYTES = 16;
const MAC_BYTES = 32;
const BINDING_BYTES = SESSION_ID_BYTES + SESSION_VERSION_BYTES + ROTATION_NONCE_BYTES;
const PAYLOAD_BYTES = BINDING_BYTES;
const PROOF_BYTES = PAYLOAD_BYTES + MAC_BYTES;
const PROOF_BODY_CHARACTERS = 96;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAC_DOMAIN = Buffer.from("laundry-desk:csrf-proof:v1\u0000", "utf8");

export type CsrfProofBinding = Readonly<{
  session_id: string;
  session_version: number;
  rotation_nonce: string;
}>;

export type CsrfProofSigner = Readonly<{
  mint: (binding: CsrfProofBinding) => string;
  verify: (proof: string, binding: CsrfProofBinding) => boolean;
}>;

const encodeUuid = (value: string, label: "session_id" | "rotation_nonce"): Buffer => {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return Buffer.from(value.replaceAll("-", ""), "hex");
};

const encodeSessionVersion = (sessionVersion: number): Buffer => {
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion <= 0) {
    throw new TypeError("session_version must be a positive safe integer");
  }
  const encoded = Buffer.alloc(SESSION_VERSION_BYTES);
  encoded.writeBigUInt64BE(BigInt(sessionVersion));
  return encoded;
};

const encodeBinding = (binding: CsrfProofBinding): Buffer =>
  Buffer.concat([
    encodeUuid(binding.session_id, "session_id"),
    encodeSessionVersion(binding.session_version),
    encodeUuid(binding.rotation_nonce, "rotation_nonce"),
  ]);

const signPayload = (secret: Buffer, payload: Buffer): Buffer =>
  createHmac("sha256", secret).update(MAC_DOMAIN).update(payload).digest();

const decodeProof = (proof: string): Buffer | null => {
  if (!CsrfProofSchema.safeParse(proof).success || !proof.startsWith(CSRF_PROOF_PREFIX)) {
    return null;
  }
  const body = proof.slice(CSRF_PROOF_PREFIX.length);
  if (body.length !== PROOF_BODY_CHARACTERS) return null;
  const decoded = Buffer.from(body, "base64url");
  if (decoded.length !== PROOF_BYTES || decoded.toString("base64url") !== body) return null;
  return decoded;
};

/**
 * Creates a signer backed by an independent high-entropy CSRF secret.
 *
 * Binary body: session UUID (16) || session version uint64 (8) ||
 * active refresh token UUID (16) || HMAC-SHA256 (32).
 */
export const createCsrfProofSigner = (secret: string): CsrfProofSigner => {
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < CSRF_PROOF_SECRET_MINIMUM_BYTES
  ) {
    throw new TypeError(
      `CSRF proof secret must contain at least ${CSRF_PROOF_SECRET_MINIMUM_BYTES} UTF-8 bytes`,
    );
  }
  const secretBytes = Buffer.from(secret, "utf8");

  const mint = (binding: CsrfProofBinding): string => {
    const payload = encodeBinding(binding);
    const body = Buffer.concat([payload, signPayload(secretBytes, payload)]).toString("base64url");
    return CsrfProofSchema.parse(`${CSRF_PROOF_PREFIX}${body}`);
  };

  const verify = (proof: string, binding: CsrfProofBinding): boolean => {
    try {
      const decoded = decodeProof(proof);
      if (decoded === null) return false;
      const payload = decoded.subarray(0, PAYLOAD_BYTES);
      const actualMac = decoded.subarray(PAYLOAD_BYTES);
      const expectedMac = signPayload(secretBytes, payload);
      const expectedBinding = encodeBinding(binding);
      const bindingValid = timingSafeEqual(payload.subarray(0, BINDING_BYTES), expectedBinding);
      const macValid = timingSafeEqual(actualMac, expectedMac);
      return bindingValid && macValid;
    } catch {
      return false;
    }
  };

  return Object.freeze({ mint, verify });
};

type CsrfTransportInput = Readonly<{
  /** Classification produced by the local request-security boundary. */
  surface: CsrfRequestSurface;
  /** Raw CSRF cookie value (readable; not HttpOnly). */
  cookie_token: string | null | undefined;
  /** Header value under CSRF_HEADER_NAME (`x-csrf-token`). */
  header_token: string | null | undefined;
}>;

type SafeCsrfCheckInput = CsrfTransportInput &
  Readonly<{
    method: "GET" | "HEAD" | "OPTIONS";
  }>;

type UnsafeCsrfCheckInput = CsrfTransportInput &
  Readonly<{
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    /** Server-owned signer; the gate verifies the exact matching cookie token. */
    proof_signer: Readonly<Pick<CsrfProofSigner, "verify">>;
    /** Binding resolved from the active server-side session and refresh token. */
    proof_binding: CsrfProofBinding;
  }>;

export type CsrfCheckInput = SafeCsrfCheckInput | UnsafeCsrfCheckInput;

export type CsrfCheckResult =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: CsrfRejectionReason }>;

const present = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0;

const constantTimeStringEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
};

const isUnsafeCsrfCheckInput = (input: CsrfCheckInput): input is UnsafeCsrfCheckInput =>
  input.method === "POST" ||
  input.method === "PUT" ||
  input.method === "PATCH" ||
  input.method === "DELETE";

/**
 * Double-submit CSRF gate for unsafe methods.
 * Safe methods (GET/HEAD/OPTIONS) pass without tokens (contracts evaluateCsrfRequest).
 */
export const checkCsrfDoubleSubmit = (input: CsrfCheckInput): CsrfCheckResult => {
  const cookieToken = input.cookie_token;
  const headerToken = input.header_token;
  const cookiePresent = present(cookieToken);
  const headerPresent = present(headerToken);
  const tokensMatch =
    cookiePresent && headerPresent && constantTimeStringEqual(cookieToken, headerToken);
  const transportSyntaxValid =
    cookiePresent &&
    headerPresent &&
    CsrfProofSchema.safeParse(cookieToken).success &&
    CsrfProofSchema.safeParse(headerToken).success;
  const proofValid =
    cookiePresent && tokensMatch && transportSyntaxValid && isUnsafeCsrfCheckInput(input)
      ? input.proof_signer.verify(cookieToken, input.proof_binding)
      : false;

  const decision: CsrfDecision = evaluateCsrfRequest({
    method: input.method,
    surface: input.surface,
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
