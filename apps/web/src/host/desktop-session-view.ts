import type { SessionView } from "../auth/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "cookie",
  "cookies",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "token",
]);
const SESSION_KEYS = Object.freeze([
  "session_id",
  "session_version",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
] as const);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCredentialBoundaryKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return FORBIDDEN_CREDENTIAL_KEYS.has(normalized) || normalized.endsWith("token");
}

function readFeatures(value: unknown): Readonly<Record<string, boolean>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (
    !entries.every(
      (entry): entry is [string, boolean] =>
        !isCredentialBoundaryKey(entry[0]) && typeof entry[1] === "boolean",
    )
  ) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries));
}

function readSession(value: unknown): SessionView["session"] | null {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_KEYS)) return null;
  const uuidKeys = ["session_id", "org_id", "store_id", "staff_id", "device_id"] as const;
  if (!uuidKeys.every((key) => isUuid(value[key]))) return null;
  if (!isPositiveInteger(value.session_version) || !isPositiveInteger(value.permission_version)) {
    return null;
  }
  return Object.freeze({
    session_id: value.session_id as string,
    session_version: value.session_version,
    org_id: value.org_id as string,
    store_id: value.store_id as string,
    staff_id: value.staff_id as string,
    device_id: value.device_id as string,
    permission_version: value.permission_version,
  });
}

function readDisplay(value: unknown): SessionView["display"] | null {
  const keys = ["store_name", "staff_name", "org_code", "store_code"] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (!keys.every((key) => typeof value[key] === "string" && value[key].length > 0)) return null;
  return Object.freeze({
    store_name: value.store_name as string,
    staff_name: value.staff_name as string,
    org_code: value.org_code as string,
    store_code: value.store_code as string,
  });
}

export function readDesktopSessionView(value: unknown): SessionView | null {
  const keys = ["session", "role", "features", "display"] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (value.role !== "admin" && value.role !== "staff") return null;
  const session = readSession(value.session);
  const features = readFeatures(value.features);
  const display = readDisplay(value.display);
  if (session === null || features === null || display === null) return null;
  return Object.freeze({
    session,
    role: value.role,
    features,
    display,
  });
}
