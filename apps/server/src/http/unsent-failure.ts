/**
 * ADR-91 §2: an outbound call is "not sent" only when the failure proves no request byte
 * reached the provider — name resolution, a refused or unreachable connection, or a TLS
 * certificate the client rejected. Anything later may have been received and is uncertain.
 */
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Walks the cause chain (fetch wraps socket errors) for a code that proves nothing was sent. */
export function failedBeforeSending(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    current = cause;
  }
  return false;
}
