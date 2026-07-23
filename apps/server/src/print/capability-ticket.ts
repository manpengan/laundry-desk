/** Server signing for one Edge print-job capability ticket. */

import {
  canonicalizeCapabilityTicketForSigning,
  CapabilityTicketPayloadSchema,
  type CapabilityTicketPayload,
} from "@laundry/contracts";
import { sign, type KeyObject } from "node:crypto";

const BASE64URL = "base64url";

export type SignedPrintCapabilityTicket = Readonly<{
  protocol_version: string;
  payload: CapabilityTicketPayload;
  sig: string;
}>;

/**
 * Sign the frozen contract authority. Binding/persisting the ticket nonce to the
 * print_jobs row happens in the server's transactional dispatch adapter.
 */
export function signPrintCapabilityTicket(
  payloadInput: unknown,
  privateKey: KeyObject,
  protocolVersion = "1.0.0",
): SignedPrintCapabilityTicket {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Print capability tickets require an Ed25519 server private key");
  }
  const payload = CapabilityTicketPayloadSchema.parse(payloadInput);
  const authority = Object.freeze({ protocol_version: protocolVersion, payload });
  const signature = sign(null, canonicalizeCapabilityTicketForSigning(authority), privateKey);
  return Object.freeze({
    ...authority,
    sig: signature.toString(BASE64URL),
  });
}
