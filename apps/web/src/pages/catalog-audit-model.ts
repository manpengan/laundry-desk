export type CatalogAuditAction =
  "created" | "updated" | "retired" | "reactivated" | "reordered" | "unchanged";

export type CatalogAuditRow = Readonly<{
  id: string;
  at_epoch_s: number;
  staff_id: string | null;
  action: CatalogAuditAction;
  codes: readonly string[];
}>;

const ACTIONS = new Set<CatalogAuditAction>([
  "created",
  "updated",
  "retired",
  "reactivated",
  "reordered",
  "unchanged",
]);

export const CATALOG_AUDIT_ACTION_LABEL: Readonly<Record<CatalogAuditAction, string>> =
  Object.freeze({
    created: "新增",
    updated: "修改",
    retired: "停用",
    reactivated: "启用",
    reordered: "排序",
    unchanged: "无变化",
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRow(value: unknown): CatalogAuditRow | null {
  if (!isRecord(value)) return null;
  const { id, at_epoch_s, staff_id, action, codes } = value;
  if (
    typeof id !== "string" ||
    typeof at_epoch_s !== "number" ||
    !Number.isInteger(at_epoch_s) ||
    (staff_id !== null && typeof staff_id !== "string") ||
    typeof action !== "string" ||
    !ACTIONS.has(action as CatalogAuditAction) ||
    !Array.isArray(codes) ||
    !codes.every((code) => typeof code === "string")
  ) {
    return null;
  }
  return Object.freeze({
    id,
    at_epoch_s,
    staff_id,
    action: action as CatalogAuditAction,
    codes: Object.freeze([...codes]),
  });
}

export function readCatalogAuditRows(data: unknown): readonly CatalogAuditRow[] {
  const payload = isRecord(data) && "result" in data ? data.result : data;
  if (!isRecord(payload) || !Array.isArray(payload.items)) return Object.freeze([]);
  return Object.freeze(
    payload.items.map(readRow).filter((row): row is CatalogAuditRow => row !== null),
  );
}
