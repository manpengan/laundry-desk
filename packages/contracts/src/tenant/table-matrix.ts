export type TenantTableScope = "global" | "org" | "store";

export type TenantTableDescriptor<TTable extends string = string> = Readonly<{
  table: TTable;
  scope: TenantTableScope;
  scopeBasis: string;
}>;

const describeTables = <const TTables extends readonly string[]>(
  scope: TenantTableScope,
  scopeBasis: string,
  tables: TTables,
): readonly TenantTableDescriptor<TTables[number]>[] =>
  Object.freeze(
    tables.map((table) =>
      Object.freeze({
        table,
        scope,
        scopeBasis,
      }),
    ),
  );

const GLOBAL_TABLES = describeTables(
  "global",
  "Root tenant identity or platform-maintained global registry; no tenant GUC policy applies.",
  ["orgs", "ai_model_registry"] as const,
);

const ORG_TABLES = describeTables(
  "org",
  "The row belongs to an org-wide resource or workflow and is isolated by org_id.",
  [
    "stores",
    "staffs",
    "customers",
    "customer_addresses",
    "card_types",
    "member_cards",
    "member_ledger",
    "punch_cards",
    "points_ledger",
    "production_batches",
    "coupons",
    "coupon_grants",
    "campaigns",
    "referral_rewards",
    "notification_templates",
    "notification_log",
    "settings",
    "backups",
    "ai_provider_keys",
    "ai_presets",
    "ai_conversations",
    "ai_messages",
    "automation_policies",
    "approval_requests",
    "ai_usage_daily",
    "ai_action_log",
  ] as const,
);

const STORE_TABLES = describeTables(
  "store",
  "The architecture requires the row to be isolated by both org_id and store_id.",
  [
    "staff_store_roles",
    "devices",
    "store_features",
    "service_types",
    "item_catalog",
    "addon_catalog",
    "color_dict",
    "brand_dict",
    "remark_dict",
    "orders",
    "order_lines",
    "garments",
    "garment_status_log",
    "payments",
    "batch_garments",
    "delivery_orders",
    "print_jobs",
    "print_templates",
    "shift_closings",
    "audit_log",
    "edge_devices",
    "primary_lease_heads",
    "primary_leases",
    "ticket_no_blocks",
    "ai_pending_actions",
  ] as const,
);

const TABLE_MATRIX = [...GLOBAL_TABLES, ...ORG_TABLES, ...STORE_TABLES] as const;

export type V2TableName = (typeof TABLE_MATRIX)[number]["table"];

const matrixByTable = new Map<V2TableName, TenantTableDescriptor<V2TableName>>();

for (const descriptor of TABLE_MATRIX) {
  if (matrixByTable.has(descriptor.table)) {
    throw new TypeError(`Duplicate v2 tenant table "${descriptor.table}"`);
  }
  matrixByTable.set(descriptor.table, descriptor);
}

export const TENANT_TABLE_MATRIX: readonly TenantTableDescriptor<V2TableName>[] =
  Object.freeze(TABLE_MATRIX);

export const getTenantTableDescriptor = (table: string): TenantTableDescriptor<V2TableName> => {
  const descriptor = matrixByTable.get(table as V2TableName);
  if (descriptor === undefined) {
    throw new TypeError(`Unknown v2 tenant table "${table}"`);
  }
  return descriptor;
};

export const getTenantTableScope = (table: string): TenantTableScope =>
  getTenantTableDescriptor(table).scope;
