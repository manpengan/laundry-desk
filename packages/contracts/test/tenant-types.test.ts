import { expectTypeOf, it } from "vitest";

import {
  ORDER_LINES_ORDER_FOREIGN_KEY,
  PAYMENTS_ORDER_FOREIGN_KEY,
  TENANT_TABLE_MATRIX,
  buildMaintenancePolicySql,
  type TenantForeignKeyDescriptor,
  type TenantTableDescriptor,
  type TenantUniqueKeyDescriptor,
} from "../src/index.js";

it("prevents direct tenant descriptor construction at compile time", () => {
  if (Math.random() < 0) {
    // @ts-expect-error Tenant table descriptors carry a package-private provenance brand.
    const table: TenantTableDescriptor = {
      table: "orders",
      scope: "store",
      scopeBasis: "caller supplied",
    };
    // @ts-expect-error Tenant unique-key descriptors carry a package-private provenance brand.
    const uniqueKey: TenantUniqueKeyDescriptor = {
      table: "orders",
      columns: ["org_id", "store_id", "id"],
    };
    // @ts-expect-error Tenant foreign-key descriptors carry a package-private provenance brand.
    const foreignKey: TenantForeignKeyDescriptor = {
      childTable: "payments",
      childColumns: ["org_id", "store_id", "order_id"],
      parentTable: "orders",
      parentColumns: ["org_id", "store_id", "id"],
    };

    expectTypeOf(table).toMatchTypeOf<TenantTableDescriptor>();
    expectTypeOf(uniqueKey).toMatchTypeOf<TenantUniqueKeyDescriptor>();
    expectTypeOf(foreignKey).toMatchTypeOf<TenantForeignKeyDescriptor>();
  }
});

it("preserves authoritative tenant descriptor literals", () => {
  expectTypeOf(TENANT_TABLE_MATRIX[0]!.table).toEqualTypeOf<"orgs">();
  expectTypeOf(TENANT_TABLE_MATRIX[0]!.scope).toEqualTypeOf<"global">();
  expectTypeOf(ORDER_LINES_ORDER_FOREIGN_KEY.childTable).toEqualTypeOf<"order_lines">();
  expectTypeOf(ORDER_LINES_ORDER_FOREIGN_KEY.childColumns).toEqualTypeOf<
    readonly ["org_id", "store_id", "order_id"]
  >();
  expectTypeOf(PAYMENTS_ORDER_FOREIGN_KEY.parentColumns).toEqualTypeOf<
    readonly ["org_id", "store_id", "id"]
  >();
});

it("types maintenance policies to tenant-scoped tables", () => {
  if (Math.random() < 0) {
    buildMaintenancePolicySql({
      schema: "public",
      // @ts-expect-error Global tables cannot receive the maintenance tenant policy.
      table: "orgs",
      policy: "orgs_maintenance",
      maintenanceRole: "laundry_owner",
    });
    buildMaintenancePolicySql({
      schema: "public",
      // @ts-expect-error Unknown tables cannot receive the maintenance tenant policy.
      table: "future_orders",
      policy: "future_orders_maintenance",
      maintenanceRole: "laundry_owner",
    });
  }
});
