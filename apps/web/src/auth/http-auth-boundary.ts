import { StaffCredentialsCompleteResponseSchema } from "@laundry/contracts";

import type { SessionView, StaffCredentialsCompleteResult, SwitchableStaff } from "./types.js";

const ACCESS_TOKEN_TTL_SECONDS = 900;
const COMPACT_ACCESS_TOKEN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCESS_SESSION_KEYS = Object.freeze([
  "access_token",
  "token_type",
  "expires_in",
  "storage",
  "session",
  "role",
  "features",
  "display",
] as const);
const BROWSER_SESSION_KEYS = Object.freeze([
  "session_id",
  "session_version",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
] as const);
const DISPLAY_KEYS = Object.freeze(["store_name", "staff_name", "org_code", "store_code"] as const);

export type ParsedAccessSession = Readonly<{
  accessToken: string;
  view: SessionView;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function readBrowserSession(data: unknown): SessionView["session"] | null {
  if (!isRecord(data) || !hasExactKeys(data, BROWSER_SESSION_KEYS)) return null;
  if (
    !isUuid(data.session_id) ||
    !isPositiveSafeInteger(data.session_version) ||
    !isUuid(data.org_id) ||
    !isUuid(data.store_id) ||
    !isUuid(data.staff_id) ||
    !isUuid(data.device_id) ||
    !isPositiveSafeInteger(data.permission_version)
  ) {
    return null;
  }
  return Object.freeze({
    session_id: data.session_id,
    session_version: data.session_version,
    org_id: data.org_id,
    store_id: data.store_id,
    staff_id: data.staff_id,
    device_id: data.device_id,
    permission_version: data.permission_version,
  });
}

function readFeatures(data: unknown): SessionView["features"] | null {
  if (!isRecord(data)) return null;
  const entries = Object.entries(data);
  if (!entries.every((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries));
}

function readDisplay(data: unknown): SessionView["display"] | null {
  if (!isRecord(data) || !hasExactKeys(data, DISPLAY_KEYS)) return null;
  if (
    typeof data.store_name !== "string" ||
    typeof data.staff_name !== "string" ||
    typeof data.org_code !== "string" ||
    typeof data.store_code !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    store_name: data.store_name,
    staff_name: data.staff_name,
    org_code: data.org_code,
    store_code: data.store_code,
  });
}

/** Strictly consume the complete server-owned access-session projection. */
export function readAccessSession(data: unknown): ParsedAccessSession | null {
  if (!isRecord(data) || !hasExactKeys(data, ACCESS_SESSION_KEYS)) return null;
  if (
    typeof data.access_token !== "string" ||
    !COMPACT_ACCESS_TOKEN.test(data.access_token) ||
    data.token_type !== "Bearer" ||
    data.expires_in !== ACCESS_TOKEN_TTL_SECONDS ||
    data.storage !== "memory_only" ||
    (data.role !== "admin" && data.role !== "staff")
  ) {
    return null;
  }
  const session = readBrowserSession(data.session);
  const features = readFeatures(data.features);
  const display = readDisplay(data.display);
  if (session === null || features === null || display === null) return null;
  return Object.freeze({
    accessToken: data.access_token,
    view: Object.freeze({ session, role: data.role, features, display }),
  });
}

export async function loadHttpStaffDirectory(
  fetchImpl: typeof fetch,
  base: string,
  accessToken: string,
): Promise<readonly SwitchableStaff[] | null> {
  try {
    const response = await fetchImpl(`${base}/api/v2/local/staff`, {
      credentials: "include",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || body.ok !== true || !Array.isArray(body.data)) return null;
    const staff: SwitchableStaff[] = [];
    for (const row of body.data) {
      if (
        !isRecord(row) ||
        !isUuid(row.staff_id) ||
        typeof row.display_name !== "string" ||
        (row.role !== "admin" && row.role !== "staff")
      ) {
        return null;
      }
      staff.push(
        Object.freeze({
          staff_id: row.staff_id,
          display_name: row.display_name,
          role: row.role,
        }),
      );
    }
    return Object.freeze(staff);
  } catch {
    return null;
  }
}

export function readStaffCredentialsCompleteResult(
  value: unknown,
): StaffCredentialsCompleteResult | null {
  const parsed = StaffCredentialsCompleteResponseSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}
