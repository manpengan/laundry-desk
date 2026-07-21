import { describe, expect, it } from "vitest";

import {
  ORG_TENANT_PREDICATE_SQL,
  STORE_TENANT_PREDICATE_SQL,
  buildMaintenancePolicySql,
  buildOrgTenantPolicySql,
  buildStoreTenantPolicySql,
} from "../src/index.js";

const tenantPolicyInput = Object.freeze({
  schema: "public",
  table: "orders",
  policy: "orders_store_scope",
  role: "laundry_app",
});

describe("A3 tenant RLS SQL templates", () => {
  it("builds deterministic org-scope SQL with the fail-closed predicate", () => {
    const input = { ...tenantPolicyInput, table: "customers", policy: "customers_org_scope" };
    const sql = buildOrgTenantPolicySql(input);

    expect(sql).toBe(buildOrgTenantPolicySql(input));
    expect(sql).toBe(`ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customers_org_scope" ON "public"."customers"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (${ORG_TENANT_PREDICATE_SQL})
  WITH CHECK (${ORG_TENANT_PREDICATE_SQL});`);
  });

  it("builds deterministic store-scope SQL with both tenant GUC predicates", () => {
    const sql = buildStoreTenantPolicySql(tenantPolicyInput);

    expect(sql).toBe(buildStoreTenantPolicySql(tenantPolicyInput));
    expect(sql).toContain('ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "public"."orders" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY "orders_store_scope" ON "public"."orders"');
    expect(sql).toContain(`USING (${STORE_TENANT_PREDICATE_SQL})`);
    expect(sql).toContain(`WITH CHECK (${STORE_TENANT_PREDICATE_SQL})`);
    expect(sql.match(/NULLIF\(current_setting\('app\.org_id', true\), ''\)::uuid/g)).toHaveLength(
      2,
    );
    expect(sql.match(/NULLIF\(current_setting\('app\.store_id', true\), ''\)::uuid/g)).toHaveLength(
      2,
    );
  });

  it.each([buildOrgTenantPolicySql, buildStoreTenantPolicySql])(
    "keeps tenant predicates row-local without cross-table SQL",
    (buildSql) => {
      const sql = buildSql(tenantPolicyInput);

      expect(sql).not.toMatch(/\b(?:SELECT|FROM|JOIN|EXISTS)\b/i);
      expect(sql).toContain("USING");
      expect(sql).toContain("WITH CHECK");
    },
  );

  it.each([
    ["schema", "public.orders"],
    ["schema", "Public"],
    ["table", "orders; DROP TABLE orgs"],
    ["table", 'orders"'],
    ["policy", "orders scope"],
    ["role", "laundry-app"],
    ["role", "laundry_app, laundry_owner"],
  ] as const)("rejects an untrusted %s identifier", (field, unsafeIdentifier) => {
    expect(() =>
      buildStoreTenantPolicySql({ ...tenantPolicyInput, [field]: unsafeIdentifier }),
    ).toThrowError(`Invalid SQL ${field} identifier`);
  });

  it("rejects overlong PostgreSQL identifiers instead of allowing truncation collisions", () => {
    expect(() =>
      buildOrgTenantPolicySql({ ...tenantPolicyInput, policy: "p".repeat(64) }),
    ).toThrowError("Invalid SQL policy identifier");
  });
});

describe("A3 maintenance policy SQL template", () => {
  it("scopes owner bypass semantics to the validated maintenance role", () => {
    const input = Object.freeze({
      schema: "public",
      table: "orders",
      policy: "orders_maintenance",
      maintenanceRole: "laundry_owner",
    });
    const sql = buildMaintenancePolicySql(input);

    expect(sql).toBe(buildMaintenancePolicySql(input));
    expect(sql).toBe(`CREATE POLICY "orders_maintenance" ON "public"."orders"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);`);
    expect(sql).not.toContain("PUBLIC");
    expect(sql).not.toContain("laundry_app");
  });

  it.each([
    ["schema", "public.pg_catalog"],
    ["table", "orders --"],
    ["policy", "maintenance;"],
    ["maintenanceRole", 'laundry_owner" OR true'],
  ] as const)("rejects an untrusted maintenance %s identifier", (field, unsafeIdentifier) => {
    expect(() =>
      buildMaintenancePolicySql({
        schema: "public",
        table: "orders",
        policy: "orders_maintenance",
        maintenanceRole: "laundry_owner",
        [field]: unsafeIdentifier,
      }),
    ).toThrowError(
      `Invalid SQL ${field === "maintenanceRole" ? "maintenance role" : field} identifier`,
    );
  });

  it("rejects the application role as a maintenance bypass", () => {
    expect(() =>
      buildMaintenancePolicySql({
        schema: "public",
        table: "orders",
        policy: "orders_maintenance",
        maintenanceRole: "laundry_app",
      }),
    ).toThrowError("Maintenance policy cannot target the application role laundry_app");
  });
});
