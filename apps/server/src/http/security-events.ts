import { createHmac } from "node:crypto";

const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_DIMENSION_CHARACTERS = 512;
const EVENT_NAME = "authentication_security" as const;
const REASONS = Object.freeze(
  new Set([
    "LOGIN_FAILED",
    "LOGIN_RATE_LIMITED",
    "CSRF_REJECTED",
    "REFRESH_REJECTED",
    "PIN_FAILED",
    "PIN_LOCKED",
  ] as const),
);

export type SecurityEventReason =
  | "LOGIN_FAILED"
  | "LOGIN_RATE_LIMITED"
  | "CSRF_REJECTED"
  | "REFRESH_REJECTED"
  | "PIN_FAILED"
  | "PIN_LOCKED";

export type SecurityEventInput = Readonly<{
  reason: SecurityEventReason;
  account?: Readonly<{
    org_code: string;
    store_code: string;
    username: string;
  }>;
  ip?: string;
  session_id?: string;
  staff_id?: string;
}>;

export type SecurityEventLogRecord = Readonly<{
  event: typeof EVENT_NAME;
  reason_code: SecurityEventReason;
  request_id: string;
  account_ref?: string;
  ip_ref?: string;
  session_ref?: string;
  staff_ref?: string;
}>;

export type SecurityEventRequest = Readonly<{
  id: string;
  log: Readonly<{
    warn: (record: unknown, message?: string) => void;
  }>;
}>;

export type SecurityEventSink = Readonly<{
  record: (request: SecurityEventRequest, input: SecurityEventInput) => void;
}>;

const INPUT_KEYS = Object.freeze(["reason", "account", "ip", "session_id", "staff_id"]);
const ACCOUNT_KEYS = Object.freeze(["org_code", "store_code", "username"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validDimension(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_DIMENSION_CHARACTERS &&
    !value.includes("\0")
  );
}

function assertInput(input: SecurityEventInput): void {
  if (!isRecord(input) || !hasOnlyKeys(input, INPUT_KEYS) || !REASONS.has(input.reason)) {
    throw new TypeError("Invalid security event");
  }
  if (input.ip !== undefined && !validDimension(input.ip)) {
    throw new TypeError("Invalid security event");
  }
  if (input.session_id !== undefined && !validDimension(input.session_id)) {
    throw new TypeError("Invalid security event");
  }
  if (input.staff_id !== undefined && !validDimension(input.staff_id)) {
    throw new TypeError("Invalid security event");
  }
  if (input.account !== undefined) {
    if (
      !isRecord(input.account) ||
      !hasOnlyKeys(input.account, ACCOUNT_KEYS) ||
      !validDimension(input.account.org_code) ||
      !validDimension(input.account.store_code) ||
      !validDimension(input.account.username)
    ) {
      throw new TypeError("Invalid security event");
    }
  }
}

function accountDimension(account: NonNullable<SecurityEventInput["account"]>): string {
  return JSON.stringify([account.org_code, account.store_code, account.username]);
}

export function createSecurityEventSink(key: string | Uint8Array): SecurityEventSink {
  const keyBytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (keyBytes.byteLength < MINIMUM_KEY_BYTES) {
    throw new TypeError("Invalid security event key");
  }
  const opaqueRef = (namespace: "account" | "ip" | "session" | "staff", value: string): string =>
    createHmac("sha256", keyBytes)
      .update("laundry-desk:security-event:v1\0", "utf8")
      .update(namespace, "utf8")
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest("base64url");

  return Object.freeze({
    record: (request, input): void => {
      assertInput(input);
      const event = Object.freeze({
        event: EVENT_NAME,
        reason_code: input.reason,
        request_id: request.id,
        ...(input.account === undefined
          ? {}
          : { account_ref: opaqueRef("account", accountDimension(input.account)) }),
        ...(input.ip === undefined ? {} : { ip_ref: opaqueRef("ip", input.ip) }),
        ...(input.session_id === undefined
          ? {}
          : { session_ref: opaqueRef("session", input.session_id) }),
        ...(input.staff_id === undefined ? {} : { staff_ref: opaqueRef("staff", input.staff_id) }),
      });
      request.log.warn(Object.freeze({ security_event: event }), "authentication security event");
    },
  });
}
