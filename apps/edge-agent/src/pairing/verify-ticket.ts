/**
 * D2 pure verification of server-signed capability tickets (A4 / architecture §10).
 *
 * Edge checks: wire shape, Ed25519 signature, device audience, origin audience,
 * and structural expiry. Business authorization remains on the server command bus.
 *
 * Full monotonic local_deadline (issued_at→exp anchored at request mono) is a
 * later D2 runtime concern; this skeleton rejects wall-clock expiry only.
 */
import {
  canonicalizeForSignatureVerification,
  parseServerSignatureCapabilityTicketCandidate,
  type CapabilityTicketPayload,
} from "@laundry/contracts";
import { verify, type KeyObject } from "node:crypto";

import { base64UrlToBytes } from "./device-keys.js";

export type TicketVerifyContext = Readonly<{
  serverPublicKey: KeyObject;
  /** This device's UUID; must equal ticket.payload.device_id. */
  deviceId: string;
  /** Exact origin allowlist; ticket.payload.origin must be a member. */
  allowedOrigins: readonly string[];
  /**
   * Wall-clock milliseconds for structural `exp` check (skeleton).
   * Production must also enforce monotonic local_deadline.
   */
  nowMs: number;
}>;

export type TicketVerifyOk = Readonly<{
  ok: true;
  protocolVersion: string;
  payload: CapabilityTicketPayload;
}>;

export type TicketVerifyErrorCode =
  "malformed" | "bad_signature" | "expired" | "wrong_device" | "wrong_origin";

export type TicketVerifyError = Readonly<{
  ok: false;
  error: TicketVerifyErrorCode;
}>;

export type TicketVerifyResult = TicketVerifyOk | TicketVerifyError;

function fail(error: TicketVerifyErrorCode): TicketVerifyError {
  return Object.freeze({ ok: false, error });
}

/**
 * Verify a server-signed capability ticket candidate.
 * `wire` is the raw envelope `{ protocol_version, payload, sig }`.
 */
export function verifyCapabilityTicket(
  wire: unknown,
  ctx: TicketVerifyContext,
): TicketVerifyResult {
  let candidate;
  try {
    candidate = parseServerSignatureCapabilityTicketCandidate(wire);
  } catch {
    return fail("malformed");
  }

  if (ctx.serverPublicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Capability ticket verification requires an Ed25519 server public key");
  }

  let message: Uint8Array;
  try {
    message = canonicalizeForSignatureVerification(candidate);
  } catch {
    return fail("malformed");
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(candidate.sig);
  } catch {
    return fail("malformed");
  }

  let signatureOk = false;
  try {
    signatureOk = verify(null, message, ctx.serverPublicKey, signature);
  } catch {
    return fail("bad_signature");
  }
  if (!signatureOk) {
    return fail("bad_signature");
  }

  const payload = candidate.payload;
  if (payload.device_id !== ctx.deviceId) {
    return fail("wrong_device");
  }
  if (!ctx.allowedOrigins.includes(payload.origin)) {
    return fail("wrong_origin");
  }

  const expMs = Date.parse(payload.exp);
  if (!Number.isFinite(expMs) || ctx.nowMs >= expMs) {
    return fail("expired");
  }

  return Object.freeze({
    ok: true,
    protocolVersion: candidate.protocol_version,
    payload,
  });
}
