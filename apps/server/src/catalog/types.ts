import type { CatalogItem } from "@laundry/domain";

export type CatalogManagedItem = Readonly<
  CatalogItem & {
    is_active: boolean;
    sort_order: number;
    version: number;
    updated_at: number;
  }
>;

export type CatalogUpsertInput = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  mnemonic?: string;
  is_active: boolean;
  sort_order?: number;
  expected_version?: number;
}>;

export type CatalogUpsertChange = Readonly<{
  before: CatalogManagedItem | null;
  after: CatalogManagedItem;
  created: boolean;
}>;

export type CatalogReorderEntry = Readonly<{ code: string; expected_version: number }>;

export type CatalogReorderChange = Readonly<{
  before: readonly CatalogManagedItem[];
  after: readonly CatalogManagedItem[];
}>;

export type CatalogManagementList = Readonly<{
  items: readonly CatalogManagedItem[];
  total: number;
}>;

export type CatalogAuditAction =
  "created" | "updated" | "retired" | "reactivated" | "reordered" | "unchanged";

export type CatalogAuditItem = Readonly<{
  id: string;
  at_epoch_s: number;
  staff_id: string | null;
  action: CatalogAuditAction;
  codes: readonly string[];
}>;

export type CatalogAuditFilter = Readonly<{
  from_epoch_s: number;
  to_epoch_s: number;
  code?: string;
  limit: number;
}>;

export type CatalogStore = Readonly<{
  listAll: () => Promise<readonly CatalogItem[]>;
  manageList?: (query: string, limit: number) => Promise<CatalogManagementList>;
  upsert?: (input: CatalogUpsertInput) => Promise<CatalogUpsertChange | null>;
  reorder?: (items: readonly CatalogReorderEntry[]) => Promise<CatalogReorderChange | null>;
  listAudit?: (filter: CatalogAuditFilter) => Promise<readonly CatalogAuditItem[]>;
}>;
