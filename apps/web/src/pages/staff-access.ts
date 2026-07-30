import { unwrapQueryResult } from "./customer-model.js";

export type StaffAccessView = Readonly<{
  staff_id: string;
  username: string;
  display_name: string;
  role: "admin" | "staff";
  privacy_admin: boolean;
  is_active: boolean;
  permission_version: number;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStaffAccessRows(value: unknown): readonly StaffAccessView[] | null {
  const result = unwrapQueryResult(value);
  if (!isRecord(result) || !Array.isArray(result.staff)) return null;
  const rows: StaffAccessView[] = [];
  for (const raw of result.staff) {
    if (
      !isRecord(raw) ||
      typeof raw.staff_id !== "string" ||
      typeof raw.username !== "string" ||
      typeof raw.display_name !== "string" ||
      (raw.role !== "admin" && raw.role !== "staff") ||
      typeof raw.privacy_admin !== "boolean" ||
      typeof raw.is_active !== "boolean" ||
      typeof raw.permission_version !== "number" ||
      !Number.isSafeInteger(raw.permission_version) ||
      raw.permission_version < 1
    ) {
      return null;
    }
    rows.push(
      Object.freeze({
        staff_id: raw.staff_id,
        username: raw.username,
        display_name: raw.display_name,
        role: raw.role,
        privacy_admin: raw.privacy_admin,
        is_active: raw.is_active,
        permission_version: raw.permission_version,
      }),
    );
  }
  return Object.freeze(rows);
}
