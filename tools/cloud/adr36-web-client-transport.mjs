import { TextDecoder } from "node:util";

import {
  ADR36_PUBLIC_ORIGIN,
  AcceptanceFailure,
  SAFE_CODE,
  UUID,
  asRecord,
  fail,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

const ORG_CODE = "local";
const STORE_CODE = "main";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
export const REFRESH_COOKIE = "__Host-laundry_refresh";
export const CSRF_COOKIE = "__Host-laundry_csrf";
const CSRF_PROOF = /^v1\.[A-Za-z0-9_-]{43,128}$/u;
const COMPACT_ACCESS_TOKEN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/u;
const ACCESS_SESSION_KEYS = Object.freeze([
  "access_token",
  "token_type",
  "expires_in",
  "storage",
  "session",
  "role",
  "features",
  "display",
]);
const SESSION_KEYS = Object.freeze([
  "session_id",
  "session_version",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
]);
const DISPLAY_KEYS = Object.freeze(["store_name", "staff_name", "org_code", "store_code"]);
const REMOTE_ERROR_CODES = new Set([
  "VALIDATION_FAILED",
  "SHIFT_CLOSED",
  "PERMISSION_DENIED",
  "RESOURCE_UNAVAILABLE",
  "POLICY_CONFIRMATION_REQUIRED",
  "POLICY_STEP_UP_REQUIRED",
  "POLICY_APPROVAL_REQUIRED",
  "POLICY_DENIED",
  "INVARIANT_FAILED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
  "IDEMPOTENCY_REPLAY_UNSUPPORTED",
  "IDEMPOTENCY_CONFLICT",
  "REPLAY_ARBITRATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "RATE_LIMITED",
]);
const UNKNOWN_REMOTE_ERROR = "REMOTE_REQUEST_FAILED";

function parsedCookie(line) {
  const parts = line.split(";");
  const separator = parts[0].indexOf("=");
  requireThat(separator > 0, "SET_COOKIE_INVALID");
  const name = parts[0].slice(0, separator);
  const value = parts[0].slice(separator + 1);
  requireThat(name === REFRESH_COOKIE || name === CSRF_COOKIE, "SET_COOKIE_UNEXPECTED");
  requireThat(
    value.length <= 4_096 && !/[\u0000-\u001f\u007f;]/u.test(value),
    "SET_COOKIE_INVALID",
  );
  const attributes = new Map(
    parts.slice(1).map((part) => {
      const trimmed = part.trim();
      const index = trimmed.indexOf("=");
      return index < 0
        ? [trimmed.toLowerCase(), true]
        : [trimmed.slice(0, index).toLowerCase(), trimmed.slice(index + 1).toLowerCase()];
    }),
  );
  requireThat(attributes.has("secure"), "COOKIE_SECURITY_INVALID");
  requireThat(!attributes.has("domain"), "COOKIE_SECURITY_INVALID");
  requireThat(attributes.get("path") === "/", "COOKIE_SECURITY_INVALID");
  requireThat(attributes.get("samesite") === "strict", "COOKIE_SECURITY_INVALID");
  requireThat(attributes.has("httponly") === (name === REFRESH_COOKIE), "COOKIE_SECURITY_INVALID");
  return Object.freeze({
    name,
    value,
    remove: value.length === 0 || attributes.get("max-age") === "0",
  });
}

export function applySetCookieHeaders(current, headers) {
  requireThat(typeof headers?.getSetCookie === "function", "SET_COOKIE_UNSUPPORTED");
  const lines = headers.getSetCookie();
  let next = Object.freeze({ ...current });
  for (const line of lines) {
    const cookie = parsedCookie(line);
    const copy = { ...next };
    if (cookie.remove) delete copy[cookie.name];
    else copy[cookie.name] = cookie.value;
    next = Object.freeze(copy);
  }
  return Object.freeze({ cookies: next, touched: lines.length > 0 });
}

export function requireAuthCookies(cookies) {
  const refresh = cookies[REFRESH_COOKIE];
  const csrf = cookies[CSRF_COOKIE];
  requireThat(
    Object.keys(cookies).length === 2 &&
      typeof refresh === "string" &&
      refresh.length > 0 &&
      typeof csrf === "string" &&
      CSRF_PROOF.test(csrf) &&
      csrf !== refresh,
    "AUTH_COOKIES_INVALID",
  );
}

function exactRecord(value, keys) {
  const record = asRecord(value, "ACCESS_SESSION_INVALID");
  const actual = Object.keys(record);
  requireThat(
    actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key)),
    "ACCESS_SESSION_INVALID",
  );
  return record;
}

function positiveInteger(value) {
  requireThat(Number.isSafeInteger(value) && value > 0, "ACCESS_SESSION_INVALID");
  return value;
}

export function parseAccessSession(value, expectedRole) {
  const data = exactRecord(value, ACCESS_SESSION_KEYS);
  requireThat(
    typeof data.access_token === "string" &&
      COMPACT_ACCESS_TOKEN.test(data.access_token) &&
      data.token_type === "Bearer" &&
      data.expires_in === 900 &&
      data.storage === "memory_only" &&
      data.role === expectedRole,
    "ACCESS_SESSION_INVALID",
  );
  const session = exactRecord(data.session, SESSION_KEYS);
  const display = exactRecord(data.display, DISPLAY_KEYS);
  const features = asRecord(data.features, "ACCESS_SESSION_INVALID");
  requireThat(
    Object.values(features).every((entry) => typeof entry === "boolean") &&
      Object.values(display).every((entry) => typeof entry === "string") &&
      display.org_code === ORG_CODE &&
      display.store_code === STORE_CODE,
    "ACCESS_SESSION_INVALID",
  );
  return Object.freeze({
    accessToken: data.access_token,
    role: data.role,
    staffId: requireUuid(session.staff_id, "ACCESS_SESSION_INVALID"),
    sessionId: requireUuid(session.session_id, "ACCESS_SESSION_INVALID"),
    sessionVersion: positiveInteger(session.session_version),
    orgId: requireUuid(session.org_id, "ACCESS_SESSION_INVALID"),
    storeId: requireUuid(session.store_id, "ACCESS_SESSION_INVALID"),
    deviceId: requireUuid(session.device_id, "ACCESS_SESSION_INVALID"),
    permissionVersion: positiveInteger(session.permission_version),
    features: Object.freeze({ ...features }),
    display: Object.freeze({ ...display }),
  });
}

function browserHeaders(session, method, withCookies) {
  const headers = {
    accept: "application/json",
    origin: ADR36_PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
    ...(session === null ? {} : { authorization: `Bearer ${session.accessToken}` }),
  };
  if (withCookies && session !== null) {
    const csrf = session.cookies[CSRF_COOKIE];
    requireThat(typeof csrf === "string" && csrf.length > 0, "CSRF_COOKIE_MISSING");
    headers.cookie = Object.entries(session.cookies)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => `${name}=${entry}`)
      .join("; ");
    headers["x-csrf-token"] = csrf;
  }
  return Object.freeze(headers);
}

async function readEnvelope(response, cookies) {
  const contentType = response.headers.get("content-type") ?? "";
  requireThat(
    contentType.toLowerCase().includes("application/json"),
    "RESPONSE_CONTENT_TYPE_INVALID",
  );
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const bytes = Number(advertised);
    requireThat(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_RESPONSE_BYTES,
      "RESPONSE_TOO_LARGE",
    );
  }
  const reader = response.body?.getReader();
  requireThat(reader !== undefined, "RESPONSE_BODY_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      requireThat(chunk.value instanceof Uint8Array, "RESPONSE_BODY_INVALID");
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The observed size violation remains authoritative even if a hostile stream rejects cancel.
        }
        fail("RESPONSE_TOO_LARGE");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    fail("RESPONSE_BODY_INVALID");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail("RESPONSE_JSON_INVALID");
  }
  const record = asRecord(body);
  if (record.ok === true) {
    requireThat(response.ok && Object.hasOwn(record, "data"), "REMOTE_SHAPE_INVALID");
    return Object.freeze({ ok: true, data: record.data, cookies });
  }
  requireThat(record.ok === false && !response.ok, "REMOTE_SHAPE_INVALID");
  const error = asRecord(record.error);
  const receivedCode = requireString(error.code, "REMOTE_ERROR_CODE_INVALID");
  requireThat(SAFE_CODE.test(receivedCode), "REMOTE_ERROR_CODE_INVALID");
  const code = REMOTE_ERROR_CODES.has(receivedCode) ? receivedCode : UNKNOWN_REMOTE_ERROR;
  const detail = typeof error.detail === "object" && error.detail !== null ? error.detail : null;
  const confirmRef = detail === null ? undefined : detail.confirm_ref;
  return Object.freeze({
    ok: false,
    code,
    ...(typeof confirmRef === "string" && UUID.test(confirmRef) ? { confirmRef } : {}),
    cookies,
  });
}

export async function transport(fetchImpl, request) {
  const method = request.method ?? "POST";
  const session = request.session ?? null;
  let response;
  try {
    response = await fetchImpl(new URL(request.path, ADR36_PUBLIC_ORIGIN), {
      method,
      headers: browserHeaders(session, method, request.withCookies === true),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail("NETWORK_REQUEST_FAILED");
  }
  const applied = applySetCookieHeaders(session?.cookies ?? Object.freeze({}), response.headers);
  const envelope = await readEnvelope(response, applied.cookies);
  return Object.freeze({ ...envelope, cookiesTouched: applied.touched });
}

export function remoteFailure(outcome) {
  fail(outcome.code === UNKNOWN_REMOTE_ERROR ? UNKNOWN_REMOTE_ERROR : `REMOTE_${outcome.code}`);
}

export function executedResult(outcome) {
  if (!outcome.ok) remoteFailure(outcome);
  const data = asRecord(outcome.data);
  requireThat(
    data.execution === "executed" && Object.hasOwn(data, "result"),
    "REMOTE_EXECUTION_INVALID",
  );
  return data.result;
}
