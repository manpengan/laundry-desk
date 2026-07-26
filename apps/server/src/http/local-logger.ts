/**
 * Local API logger policy. Request bodies are not serialized by default; these paths are
 * an additional fail-closed guard for code that later attaches structured auth material.
 */

export const LOCAL_LOG_REDACTION_PATHS = Object.freeze([
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "body.password",
  "body.pin",
  "body.access_token",
  "body.refresh_token",
  "body.csrf_token",
  "body.token",
  "data.password",
  "data.pin",
  "data.access_token",
  "data.refresh_token",
  "data.csrf_token",
  "data.token",
] as const);

export type LocalLoggerOptions = Readonly<{
  level: "info";
  redact: Readonly<{
    paths: string[];
    censor: "[REDACTED]";
  }>;
}>;

export function createLocalLoggerOptions(): LocalLoggerOptions {
  const paths: string[] = [...LOCAL_LOG_REDACTION_PATHS];
  Object.freeze(paths);
  return Object.freeze({
    level: "info" as const,
    redact: Object.freeze({
      paths,
      censor: "[REDACTED]" as const,
    }),
  });
}

const SAFE_ERROR_TYPES = Object.freeze(
  new Set(["Error", "TypeError", "RangeError", "IdentityError", "AuthError", "ZodError"]),
);

/** Preserve operational context without serializing attacker-controlled error text or stacks. */
export function safeErrorContext(error: unknown): Readonly<{ error_type: string }> {
  const candidate = error instanceof Error ? error.name : "";
  return Object.freeze({
    error_type: SAFE_ERROR_TYPES.has(candidate) ? candidate : "UnknownError",
  });
}
