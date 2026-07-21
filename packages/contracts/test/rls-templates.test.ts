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
const orgTenantPolicyInput = Object.freeze({
  ...tenantPolicyInput,
  table: "customers",
  policy: "customers_org_scope",
});

type RuntimePolicyBuilder = (input: unknown) => string;

const runtimeBuildOrgTenantPolicySql = buildOrgTenantPolicySql as RuntimePolicyBuilder;
const runtimeBuildStoreTenantPolicySql = buildStoreTenantPolicySql as RuntimePolicyBuilder;
const runtimeBuildMaintenancePolicySql = buildMaintenancePolicySql as RuntimePolicyBuilder;

describe("A3 tenant RLS SQL templates", () => {
  it("builds deterministic org-scope SQL with the fail-closed predicate", () => {
    const sql = buildOrgTenantPolicySql(orgTenantPolicyInput);

    expect(sql).toBe(buildOrgTenantPolicySql(orgTenantPolicyInput));
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

  it.each([
    [runtimeBuildOrgTenantPolicySql, orgTenantPolicyInput],
    [runtimeBuildStoreTenantPolicySql, tenantPolicyInput],
  ] as const)("keeps tenant predicates row-local without cross-table SQL", (buildSql, input) => {
    const sql = buildSql(input);

    expect(sql).not.toMatch(/\b(?:SELECT|FROM|JOIN|EXISTS)\b/i);
    expect(sql).toContain("USING");
    expect(sql).toContain("WITH CHECK");
  });

  it.each([
    [runtimeBuildOrgTenantPolicySql, tenantPolicyInput, "requires an org-scope table"],
    [runtimeBuildStoreTenantPolicySql, orgTenantPolicyInput, "requires a store-scope table"],
    [
      runtimeBuildOrgTenantPolicySql,
      { ...tenantPolicyInput, table: "orgs", policy: "orgs_scope" },
      "cannot target global-scope table",
    ],
    [
      runtimeBuildStoreTenantPolicySql,
      { ...tenantPolicyInput, table: "orgs", policy: "orgs_scope" },
      "cannot target global-scope table",
    ],
    [
      runtimeBuildStoreTenantPolicySql,
      { ...tenantPolicyInput, table: "future_orders" },
      'Unknown v2 tenant table "future_orders"',
    ],
  ] as const)(
    "fails closed when a tenant policy table is out of scope",
    (buildSql, input, error) => {
      expect(() => buildSql(input)).toThrowError(error);
    },
  );

  it("types tenant policy builders to their matrix scope", () => {
    if (Math.random() < 0) {
      // @ts-expect-error Store tables cannot enter the org-scope SQL builder.
      buildOrgTenantPolicySql(tenantPolicyInput);
      // @ts-expect-error Org tables cannot enter the store-scope SQL builder.
      buildStoreTenantPolicySql(orgTenantPolicyInput);
    }
  });

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
      buildOrgTenantPolicySql({ ...orgTenantPolicyInput, policy: "p".repeat(64) }),
    ).toThrowError("Invalid SQL policy identifier");
  });

  it("rejects a boxed stateful identifier without coercing it", () => {
    let coercions = 0;
    const statefulIdentifier = {
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return coercions === 1 ? "public" : 'public"; DROP TABLE orgs; --';
      },
    };

    expect(() =>
      runtimeBuildStoreTenantPolicySql({
        ...tenantPolicyInput,
        schema: statefulIdentifier,
      }),
    ).toThrowError("must be a primitive string");
    expect(coercions).toBe(0);
  });

  it("uses one own data snapshot when a Proxy changes table reads", () => {
    let tableReads = 0;
    const input = new Proxy(
      { ...tenantPolicyInput },
      {
        get: (target, property, receiver) => {
          if (property === "table") {
            tableReads += 1;
            return tableReads === 1 ? "customers" : "orders";
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const sql = runtimeBuildStoreTenantPolicySql(input);

    expect(tableReads).toBe(0);
    expect(sql).toContain('ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;');
    expect(sql).not.toContain('"customers"');
  });

  it.each([
    ["schema", null],
    ["policy", undefined],
    ["role", 42],
    ["table", new String("orders")],
  ] as const)("rejects a non-primitive %s field", (field, value) => {
    expect(() =>
      runtimeBuildStoreTenantPolicySql({ ...tenantPolicyInput, [field]: value }),
    ).toThrowError("must be a primitive string");
  });

  it("rejects accessor-bearing policy input without invoking the accessor", () => {
    let reads = 0;
    const input = { ...tenantPolicyInput } as Record<string, unknown>;
    Object.defineProperty(input, "table", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "orders";
      },
    });

    expect(() => runtimeBuildStoreTenantPolicySql(input)).toThrowError("own data property");
    expect(reads).toBe(0);
  });

  it.each([
    [Object.assign(Object.create({ inherited: true }), tenantPolicyInput), "plain object"],
    [
      {
        schema: tenantPolicyInput.schema,
        table: tenantPolicyInput.table,
        policy: tenantPolicyInput.policy,
      },
      "exactly the properties",
    ],
    [{ ...tenantPolicyInput, extra: "unexpected" }, "exactly the properties"],
  ] as const)("rejects an invalid policy input object", (input, error) => {
    expect(() => runtimeBuildStoreTenantPolicySql(input)).toThrowError(error);
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

  it.each(["laundry_app", "reporting_app", "migration_worker"])(
    "rejects non-owner role %s as a maintenance bypass",
    (maintenanceRole) => {
      expect(() =>
        buildMaintenancePolicySql({
          schema: "public",
          table: "orders",
          policy: "orders_maintenance",
          maintenanceRole,
        }),
      ).toThrowError("Maintenance policy role must be laundry_owner");
    },
  );

  it("uses one own data snapshot when a Proxy changes maintenanceRole reads", () => {
    let roleReads = 0;
    const input = new Proxy(
      {
        schema: "public",
        table: "orders",
        policy: "orders_maintenance",
        maintenanceRole: "laundry_owner",
      },
      {
        get: (target, property, receiver) => {
          if (property === "maintenanceRole") {
            roleReads += 1;
            return roleReads === 1 ? "reporting_app" : "laundry_owner";
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const sql = runtimeBuildMaintenancePolicySql(input);

    expect(roleReads).toBe(0);
    expect(sql).toContain('TO "laundry_owner"');
    expect(sql).not.toContain('"reporting_app"');
  });

  it.each([
    ["future_orders", 'Unknown v2 tenant table "future_orders"'],
    ["orgs", "cannot target global-scope table"],
  ] as const)("rejects maintenance policy table %s", (table, error) => {
    expect(() =>
      runtimeBuildMaintenancePolicySql({
        schema: "public",
        table,
        policy: "maintenance_scope",
        maintenanceRole: "laundry_owner",
      }),
    ).toThrowError(error);
  });
});
