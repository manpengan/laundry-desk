export type TenantTableScope = "global" | "org" | "store";

declare const TENANT_TABLE_DESCRIPTOR_BRAND: unique symbol;

export type TenantTableDescriptor<
  TTable extends string = string,
  TScope extends TenantTableScope = TenantTableScope,
  TScopeBasis extends string = string,
> = Readonly<{
  table: TTable;
  scope: TScope;
  scopeBasis: TScopeBasis;
  [TENANT_TABLE_DESCRIPTOR_BRAND]: true;
}>;

type TenantTableDescriptorTuple<
  TTables extends readonly string[],
  TScope extends TenantTableScope,
  TScopeBasis extends string,
> = {
  readonly [TIndex in keyof TTables]: TenantTableDescriptor<
    TTables[TIndex] & string,
    TScope,
    TScopeBasis
  >;
};

const registeredTenantTableDescriptors = new WeakSet<object>();

const describeTables = <
  const TScope extends TenantTableScope,
  const TScopeBasis extends string,
  const TTables extends readonly string[],
>(
  scope: TScope,
  scopeBasis: TScopeBasis,
  tables: TTables,
): TenantTableDescriptorTuple<TTables, TScope, TScopeBasis> =>
  Object.freeze(
    tables.map((table) => {
      const descriptor = Object.freeze({
        table,
        scope,
        scopeBasis,
      }) as TenantTableDescriptor<typeof table, TScope, TScopeBasis>;
      registeredTenantTableDescriptors.add(descriptor);
      return descriptor;
    }),
  ) as unknown as TenantTableDescriptorTuple<TTables, TScope, TScopeBasis>;

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
    "customer_erasure_tombstones",
    "customer_identifiers",
    "customer_privacy_hmac_keys",
    "customer_profiles",
    "card_types",
    "member_cards",
    "member_ledger",
    "member_memberships",
    "member_points_policies",
    "member_punch_types",
    "member_tiers",
    "punch_cards",
    "punch_card_ledger",
    "points_allocations",
    "points_ledger",
    "coupons",
    "coupon_grants",
    "coupon_redemptions",
    "coupon_redemption_reversals",
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
    "store_pricing_policies",
    "color_dict",
    "brand_dict",
    "remark_dict",
    "orders",
    "order_lines",
    "garments",
    "garment_photos",
    "garment_status_log",
    "garment_incidents",
    "payments",
    "production_batches",
    "batch_garments",
    "production_handoff_attempts",
    "production_handoff_attempt_items",
    "production_handoff_checkpoints",
    "production_handoff_discrepancy_resolutions",
    "garment_qc_log",
    "delivery_orders",
    "notification_delivery_batches",
    "notification_deliveries",
    "notification_delivery_attempts",
    "notification_delivery_receipts",
    "campaigns",
    "campaign_audience_snapshots",
    "campaign_budget_ledger",
    "campaign_coupon_batches",
    "campaign_coupon_grants",
    "print_jobs",
    "print_device_receipt_heads",
    "print_templates",
    "shift_closings",
    "audit_log",
    "edge_authority_challenges",
    "edge_devices",
    "offline_grants",
    "offline_grant_replay_state",
    "primary_lease_heads",
    "primary_lease_replay_state",
    "primary_leases",
    "edge_replay_records",
    "ticket_no_blocks",
    "ai_pending_actions",
  ] as const,
);

const TABLE_MATRIX = Object.freeze([...GLOBAL_TABLES, ...ORG_TABLES, ...STORE_TABLES] as const);

export type V2TableName = (typeof TABLE_MATRIX)[number]["table"];
export type GlobalScopeTableName = (typeof GLOBAL_TABLES)[number]["table"];
export type OrgScopeTableName = (typeof ORG_TABLES)[number]["table"];
export type StoreScopeTableName = (typeof STORE_TABLES)[number]["table"];

type TenantTableMatrixDescriptor = (typeof TABLE_MATRIX)[number];

const matrixByTable = new Map<V2TableName, TenantTableMatrixDescriptor>();

for (const descriptor of TABLE_MATRIX) {
  if (matrixByTable.has(descriptor.table)) {
    throw new TypeError(`Duplicate v2 tenant table "${descriptor.table}"`);
  }
  matrixByTable.set(descriptor.table, descriptor);
}

export const TENANT_TABLE_MATRIX = TABLE_MATRIX;

export function getTenantTableDescriptor<const TTable extends V2TableName>(
  table: TTable,
): Extract<TenantTableMatrixDescriptor, { readonly table: TTable }>;
export function getTenantTableDescriptor(table: string): TenantTableMatrixDescriptor;
export function getTenantTableDescriptor(table: string): TenantTableMatrixDescriptor {
  const descriptor = matrixByTable.get(table as V2TableName);
  if (descriptor === undefined) {
    throw new TypeError(`Unknown v2 tenant table "${table}"`);
  }
  return descriptor;
}

export const getTenantTableScope = (table: string): TenantTableScope =>
  getTenantTableDescriptor(table).scope;

export const isTenantTableDescriptor = (value: unknown): value is TenantTableMatrixDescriptor =>
  typeof value === "object" && value !== null && registeredTenantTableDescriptors.has(value);
