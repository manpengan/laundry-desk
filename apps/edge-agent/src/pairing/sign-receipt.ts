/**
 * D2 device-signed execution receipt (architecture §10 / A4 signed envelope).
 * Signs only the A4 canonical authority bytes — no business validation.
 */
import {
  canonicalizeExecutionReceiptForSigning,
  type ExecutionReceiptPayload,
} from "@laundry/contracts";
import { sign, type KeyObject } from "node:crypto";

import { bytesToBase64Url } from "./device-keys.js";

/** M1 wire protocol_version for Edge signed envelopes. */
export const EDGE_SIGNED_PROTOCOL_VERSION = "1.0.0";

export type SignedExecutionReceipt = Readonly<{
  protocol_version: string;
  payload: ExecutionReceiptPayload;
  sig: string;
}>;

/**
 * Sign an execution receipt with the device private key.
 * Payload shape is validated by the contracts canonicalize helper.
 */
export function signReceipt(
  payload: ExecutionReceiptPayload,
  privateKey: KeyObject,
  protocolVersion: string = EDGE_SIGNED_PROTOCOL_VERSION,
): SignedExecutionReceipt {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Execution receipts require an Ed25519 device private key");
  }
  const authority = Object.freeze({
    protocol_version: protocolVersion,
    payload,
  });
  const message = canonicalizeExecutionReceiptForSigning(authority);
  const sig = bytesToBase64Url(new Uint8Array(sign(null, message, privateKey)));
  return Object.freeze({
    protocol_version: protocolVersion,
    payload,
    sig,
  });
}
