import { describe, expect, it } from "vitest";

import {
  TENANT_TABLE_MATRIX,
  getTenantTableDescriptor,
  getTenantTableScope,
  isTenantTableDescriptor,
} from "../src/index.js";

const EXPECTED_TABLES = Object.freeze([
  "addon_catalog",
  "ai_action_log",
  "ai_conversations",
  "ai_messages",
  "ai_model_registry",
  "ai_pending_actions",
  "ai_presets",
  "ai_provider_keys",
  "ai_usage_daily",
  "approval_requests",
  "audit_log",
  "automation_policies",
  "automation_policy_usage_daily",
  "backups",
  "batch_garments",
  "brand_dict",
  "campaign_audience_snapshots",
  "campaign_budget_ledger",
  "campaign_coupon_batches",
  "campaign_coupon_grants",
  "campaigns",
  "card_types",
  "color_dict",
  "coupon_grants",
  "coupon_redemption_reversals",
  "coupon_redemptions",
  "coupons",
  "customer_addresses",
  "customer_erasure_tombstones",
  "customer_identifiers",
  "customer_portal_access_log",
  "customer_portal_preferences",
  "customer_portal_sessions",
  "customer_privacy_hmac_keys",
  "customer_profiles",
  "customers",
  "delivery_appointments",
  "delivery_orders",
  "delivery_policies",
  "delivery_tasks",
  "devices",
  "edge_authority_challenges",
  "edge_devices",
  "edge_replay_records",
  "garment_incidents",
  "garment_photos",
  "garment_qc_log",
  "garment_status_log",
  "garments",
  "group_buy_redemptions",
  "group_buy_vouchers",
  "item_catalog",
  "member_cards",
  "member_ledger",
  "member_memberships",
  "member_points_policies",
  "member_punch_types",
  "member_tiers",
  "notification_deliveries",
  "notification_delivery_attempts",
  "notification_delivery_batches",
  "notification_delivery_receipts",
  "notification_log",
  "notification_templates",
  "offline_grant_replay_state",
  "offline_grants",
  "order_lines",
  "orders",
  "orgs",
  "payments",
  "points_allocations",
  "points_ledger",
  "primary_lease_heads",
  "primary_lease_replay_state",
  "primary_leases",
  "print_device_receipt_heads",
  "print_jobs",
  "print_templates",
  "production_batches",
  "production_handoff_attempt_items",
  "production_handoff_attempts",
  "production_handoff_checkpoints",
  "production_handoff_discrepancy_resolutions",
  "punch_card_ledger",
  "punch_cards",
  "referral_rewards",
  "remark_dict",
  "service_types",
  "settings",
  "shift_closings",
  "staff_store_roles",
  "staffs",
  "store_features",
  "store_pricing_policies",
  "stores",
  "ticket_no_blocks",
] as const);

const EXPECTED_GLOBAL_TABLES = Object.freeze(["ai_model_registry", "orgs"] as const);
const EXPECTED_ORG_TABLES = Object.freeze([
  "ai_conversations",
  "ai_messages",
  "ai_presets",
  "ai_provider_keys",
  "ai_usage_daily",
  "approval_requests",
  "backups",
  "card_types",
  "coupon_grants",
  "coupon_redemption_reversals",
  "coupon_redemptions",
  "coupons",
  "customer_addresses",
  "customer_erasure_tombstones",
  "customer_identifiers",
  "customer_portal_preferences",
  "customer_privacy_hmac_keys",
  "customer_profiles",
  "customers",
  "member_cards",
  "member_ledger",
  "member_memberships",
  "member_points_policies",
  "member_punch_types",
  "member_tiers",
  "notification_log",
  "notification_templates",
  "points_allocations",
  "points_ledger",
  "punch_card_ledger",
  "punch_cards",
  "settings",
  "staffs",
  "stores",
] as const);
const EXPECTED_STORE_TABLES = Object.freeze([
  "addon_catalog",
  "ai_action_log",
  "ai_pending_actions",
  "audit_log",
  "automation_policies",
  "automation_policy_usage_daily",
  "batch_garments",
  "brand_dict",
  "campaign_audience_snapshots",
  "campaign_budget_ledger",
  "campaign_coupon_batches",
  "campaign_coupon_grants",
  "campaigns",
  "color_dict",
  "customer_portal_access_log",
  "customer_portal_sessions",
  "delivery_appointments",
  "delivery_orders",
  "delivery_policies",
  "delivery_tasks",
  "devices",
  "edge_authority_challenges",
  "edge_devices",
  "edge_replay_records",
  "garment_incidents",
  "garment_photos",
  "garment_qc_log",
  "garment_status_log",
  "garments",
  "group_buy_redemptions",
  "group_buy_vouchers",
  "item_catalog",
  "notification_deliveries",
  "notification_delivery_attempts",
  "notification_delivery_batches",
  "notification_delivery_receipts",
  "offline_grant_replay_state",
  "offline_grants",
  "order_lines",
  "orders",
  "payments",
  "primary_lease_heads",
  "primary_lease_replay_state",
  "primary_leases",
  "print_device_receipt_heads",
  "print_jobs",
  "print_templates",
  "production_batches",
  "production_handoff_attempt_items",
  "production_handoff_attempts",
  "production_handoff_checkpoints",
  "production_handoff_discrepancy_resolutions",
  "referral_rewards",
  "remark_dict",
  "service_types",
  "shift_closings",
  "staff_store_roles",
  "store_features",
  "store_pricing_policies",
  "ticket_no_blocks",
] as const);

describe("A3 tenant table matrix", () => {
  it("classifies every v2 architecture table exactly once", () => {
    const tableNames = TENANT_TABLE_MATRIX.map(({ table }) => table);

    expect([...tableNames].sort()).toEqual(EXPECTED_TABLES);
    expect(new Set(tableNames).size).toBe(tableNames.length);
    expect(
      TENANT_TABLE_MATRIX.every(({ scope }) => ["global", "org", "store"].includes(scope)),
    ).toBe(true);
  });

  it.each([
    ["global", EXPECTED_GLOBAL_TABLES],
    ["org", EXPECTED_ORG_TABLES],
    ["store", EXPECTED_STORE_TABLES],
  ] as const)("freezes the authoritative %s-scope assignments", (scope, expectedTables) => {
    expect(
      TENANT_TABLE_MATRIX.filter((descriptor) => descriptor.scope === scope)
        .map(({ table }) => table)
        .sort(),
    ).toEqual(expectedTables);
  });

  it("ratifies bounded automation authority and evidence as strict store scope", () => {
    expect(getTenantTableScope("automation_policies")).toBe("store");
    expect(getTenantTableScope("automation_policy_usage_daily")).toBe("store");
    expect(getTenantTableScope("ai_action_log")).toBe("store");
  });

  it("registers ordinary grant replay high-water as a strict store-scoped RLS table", () => {
    const replayState = getTenantTableDescriptor("offline_grant_replay_state");

    expect(replayState.scope).toBe("store");
    expect(replayState.scopeBasis).toMatch(/both org_id and store_id/u);
  });

  it("registers print receipt high-water as a strict store-scoped RLS table", () => {
    expect(getTenantTableDescriptor("print_device_receipt_heads").scope).toBe("store");
  });

  it("supersedes the production batch placeholder with ADR-45 store-scoped custody tables", () => {
    const handoffTables = [
      "production_batches",
      "batch_garments",
      "production_handoff_attempts",
      "production_handoff_attempt_items",
      "production_handoff_checkpoints",
      "production_handoff_discrepancy_resolutions",
      "garment_qc_log",
    ] as const;

    expect(handoffTables.map((table) => getTenantTableDescriptor(table).scope)).toEqual(
      handoffTables.map(() => "store"),
    );
  });

  it("fails closed for unknown table names", () => {
    expect(() => getTenantTableDescriptor("not_a_v2_table")).toThrowError(
      'Unknown v2 tenant table "not_a_v2_table"',
    );
    expect(() => getTenantTableScope("orders_archive")).toThrowError(
      'Unknown v2 tenant table "orders_archive"',
    );
  });

  it("exposes a deeply immutable matrix", () => {
    const orders = getTenantTableDescriptor("orders");

    expect(Object.isFrozen(TENANT_TABLE_MATRIX)).toBe(true);
    expect(Object.isFrozen(orders)).toBe(true);
    expect(Reflect.set(orders, "scope", "global")).toBe(false);
    expect(getTenantTableScope("orders")).toBe("store");
  });

  it("proves table descriptor provenance instead of trusting structural clones", () => {
    const orders = getTenantTableDescriptor("orders");

    expect(isTenantTableDescriptor(orders)).toBe(true);
    expect(TENANT_TABLE_MATRIX.every(isTenantTableDescriptor)).toBe(true);
    expect(isTenantTableDescriptor({ ...orders })).toBe(false);
    expect(isTenantTableDescriptor(JSON.parse(JSON.stringify(orders)))).toBe(false);
    expect(
      isTenantTableDescriptor({
        table: "orders",
        scope: "store",
        scopeBasis: orders.scopeBasis,
      }),
    ).toBe(false);
  });
});
