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
  "backups",
  "batch_garments",
  "brand_dict",
  "campaigns",
  "card_types",
  "color_dict",
  "coupon_grants",
  "coupons",
  "customer_addresses",
  "customers",
  "delivery_orders",
  "devices",
  "edge_devices",
  "garment_status_log",
  "garments",
  "item_catalog",
  "member_cards",
  "member_ledger",
  "notification_log",
  "notification_templates",
  "order_lines",
  "orders",
  "orgs",
  "payments",
  "points_ledger",
  "primary_lease_heads",
  "primary_leases",
  "print_jobs",
  "print_templates",
  "production_batches",
  "punch_cards",
  "referral_rewards",
  "remark_dict",
  "service_types",
  "settings",
  "shift_closings",
  "staff_store_roles",
  "staffs",
  "store_features",
  "stores",
  "ticket_no_blocks",
] as const);

const EXPECTED_GLOBAL_TABLES = Object.freeze(["ai_model_registry", "orgs"] as const);
const EXPECTED_ORG_TABLES = Object.freeze([
  "ai_action_log",
  "ai_conversations",
  "ai_messages",
  "ai_presets",
  "ai_provider_keys",
  "ai_usage_daily",
  "approval_requests",
  "automation_policies",
  "backups",
  "campaigns",
  "card_types",
  "coupon_grants",
  "coupons",
  "customer_addresses",
  "customers",
  "member_cards",
  "member_ledger",
  "notification_log",
  "notification_templates",
  "points_ledger",
  "production_batches",
  "punch_cards",
  "referral_rewards",
  "settings",
  "staffs",
  "stores",
] as const);
const EXPECTED_STORE_TABLES = Object.freeze([
  "addon_catalog",
  "ai_pending_actions",
  "audit_log",
  "batch_garments",
  "brand_dict",
  "color_dict",
  "delivery_orders",
  "devices",
  "edge_devices",
  "garment_status_log",
  "garments",
  "item_catalog",
  "order_lines",
  "orders",
  "payments",
  "primary_lease_heads",
  "primary_leases",
  "print_jobs",
  "print_templates",
  "remark_dict",
  "service_types",
  "shift_closings",
  "staff_store_roles",
  "store_features",
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

  it("keeps optional store filters at org scope", () => {
    expect(getTenantTableScope("automation_policies")).toBe("org");
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
