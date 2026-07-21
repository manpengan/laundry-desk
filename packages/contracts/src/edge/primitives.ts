import { z } from "zod";

const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const isExactUtcTimestamp = (value: string): boolean => {
  if (!EXACT_UTC_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

/** A4 §2.2: exact millisecond UTC representation; no offsets or omitted milliseconds. */
export const ExactUtcTimestampSchema = z.string().refine(isExactUtcTimestamp, {
  message: "Expected exact ISO-8601 UTC milliseconds",
});

/** A4 §2.2: detached signatures use unpadded Base64URL transport encoding. */
export const Base64UrlSignatureSchema = z.string().min(43).max(256).regex(BASE64URL);

/** Architecture §10: replay-resistant one-time identifiers are UUIDs on the wire. */
export const EdgeNonceSchema = z.uuid();

/** Architecture §10: the only sensitive local actions authorized by capability tickets. */
export const EdgeCapabilityActionSchema = z.enum(["cash_drawer_open", "print_job"]);

/** Architecture §10: execution receipts expose a closed result vocabulary. */
export const EdgeExecutionResultSchema = z.enum(["succeeded", "failed"]);

const isExactEdgeOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.hostname === "") return false;
  if (url.protocol === "https:") return value === url.origin;
  return (
    url.protocol === "app:" &&
    url.port === "" &&
    url.pathname === "" &&
    url.search === "" &&
    url.hash === "" &&
    value === url.href
  );
};

/** Exact browser/App origin syntax; the configured exact allowlist remains an Edge runtime decision. */
export const EdgeOriginSchema = z.string().refine(isExactEdgeOrigin, {
  message: "Expected an exact HTTPS or app origin without path, query, fragment, or credentials",
});
