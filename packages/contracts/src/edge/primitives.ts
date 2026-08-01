import { z } from "zod";

const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CUPS_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[1-9][0-9]{0,9}$/u;

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

/** Supported printer families. The signed capability and immutable job row use this exact set. */
export const EdgePrinterKindSchema = z.enum(["xp58", "dl206", "gp3120"]);

/** Lowercase SHA-256 wire encoding used to bind immutable print snapshots. */
export const Sha256HexSchema = z.string().regex(SHA256_HEX, "Expected lowercase SHA-256 hex");

/** Exact CUPS request id returned by `lp`; whitespace and shell syntax are forbidden. */
export const CupsJobIdSchema = z.string().regex(CUPS_JOB_ID, "Expected a bounded CUPS job id");

/** Architecture §10: execution receipts expose a closed result vocabulary. */
export const EdgeExecutionResultSchema = z.enum(["succeeded", "failed", "uncertain"]);

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
