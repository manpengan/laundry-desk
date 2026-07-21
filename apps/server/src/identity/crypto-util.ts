/**
 * Shared crypto helpers for C6 identity (opaque tokens, compact access tokens, CSRF proofs).
 * Uses node:crypto only — no production HSM required for the skeleton.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenClaims,
  parseAccessTokenClaims,
} from "@laundry/contracts";

import type { EpochSeconds, Uuid } from "./types.js";

const TOKEN_BYTES = 32;

export const randomToken = (bytes = TOKEN_BYTES): string =>
  randomBytes(bytes).toString("base64url");

export const sha256Hex = (value: string): string =>
  createHmac("sha256", "laundry-desk-token-hash").update(value, "utf8").digest("hex");

/** Hash refresh/CSRF secrets for storage (HMAC-SHA256 hex). */
export const hashOpaqueSecret = (secret: string): string => sha256Hex(secret);

export const constantTimeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const b64urlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const fromB64urlJson = (segment: string): unknown => {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json) as unknown;
};

export type AccessTokenSigner = Readonly<{
  sign: (claims: AccessTokenClaims) => string;
  verify: (token: string) => AccessTokenClaims | null;
}>;

/**
 * Compact JWT-like access token: header.payload.hmac (HS256).
 * Aligns with contracts CompactAccessTokenSchema (three base64url segments).
 */
export const createAccessTokenSigner = (secret: string): AccessTokenSigner => {
  const sign = (claims: AccessTokenClaims): string => {
    const header = b64urlJson({ alg: "HS256", typ: "AT" });
    const payload = b64urlJson(claims);
    const sig = createHmac("sha256", secret)
      .update(`${header}.${payload}`, "utf8")
      .digest("base64url");
    return `${header}.${payload}.${sig}`;
  };

  const verify = (token: string): AccessTokenClaims | null => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    if (header === undefined || payload === undefined || sig === undefined) return null;
    const expected = createHmac("sha256", secret)
      .update(`${header}.${payload}`, "utf8")
      .digest("base64url");
    if (!constantTimeEqual(sig, expected)) return null;
    try {
      const raw = fromB64urlJson(payload);
      return parseAccessTokenClaims(raw);
    } catch {
      return null;
    }
  };

  return Object.freeze({ sign, verify });
};

export const buildAccessClaims = (input: {
  session_id: Uuid;
  session_version: number;
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  permission_version: number;
  authentication_method: "password" | "pin" | "refresh";
  now: EpochSeconds;
}): AccessTokenClaims => {
  const iat = input.now;
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
  return parseAccessTokenClaims({
    session_id: input.session_id,
    session_version: input.session_version,
    org_id: input.org_id,
    store_id: input.store_id,
    staff_id: input.staff_id,
    device_id: input.device_id,
    permission_version: input.permission_version,
    authentication_method: input.authentication_method,
    iat,
    exp,
  });
};

/** CSRF proof format: v1.<43–128 base64url chars> (contracts CsrfProofSchema). */
export const mintCsrfProof = (): string => {
  const body = randomBytes(32).toString("base64url");
  return `v1.${body}`;
};

export const newUuid = (): Uuid => {
  // crypto.randomUUID is available on Node 22+
  return globalThis.crypto.randomUUID();
};
