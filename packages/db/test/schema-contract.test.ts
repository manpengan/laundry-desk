import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTenantTableDescriptor, getTenantTableScope } from "@laundry/contracts";
import { describe, expect, it } from "vitest";

import {
  APP_ORG_ID_GUC,
  APP_STAFF_ID_GUC,
  APP_STORE_ID_GUC,
  DEFERRED_V2_TABLES_NOTE,
  LAUNDRY_APP_ROLE,
  LAUNDRY_OWNER_ROLE,
  M1_ALL_TABLE_NAMES,
  M1_MATRIX_TABLE_NAMES,
  M1_MATRIX_TABLES,
  M1_SESSION_TABLE_NAMES,
  M1_SESSION_TABLES,
  M2_CATALOG_RLS_TABLES,
  M2_CATALOG_TABLE_NAMES,
  M2_CATALOG_TABLES,
  M2_ORDER_RLS_TABLES,
  M2_ORDER_TABLE_NAMES,
  M2_ORDER_TABLES,
  buildM1RlsMigrationSql,
  schema,
} from "../src/index.js";

const columnNames = (table: (typeof schema)[keyof typeof schema]): string[] =>
  Object.values(getTableColumns(table)).map((column) => column.name);

describe("M1 schema contract vs A3 matrix", () => {
  it("exports exactly the M1 matrix table names as drizzle tables", () => {
    expect(Object.keys(M1_MATRIX_TABLES).sort()).toEqual([...M1_MATRIX_TABLE_NAMES].sort());
    for (const name of M1_MATRIX_TABLE_NAMES) {
      expect(getTableName(M1_MATRIX_TABLES[name])).toBe(name);
      expect(() => getTenantTableDescriptor(name)).not.toThrow();
    }
  });

  it("matches A3 scopes for every matrix table in the M1 subset", () => {
    expect(getTenantTableScope("orgs")).toBe("global");
    expect(getTenantTableScope("stores")).toBe("org");
    expect(getTenantTableScope("staffs")).toBe("org");
    expect(getTenantTableScope("settings")).toBe("org");
    expect(getTenantTableScope("staff_store_roles")).toBe("store");
    expect(getTenantTableScope("store_features")).toBe("store");
    expect(getTenantTableScope("audit_log")).toBe("store");
  });

  it("uses uuid primary keys and tenant key columns per scope", () => {
    for (const name of M1_MATRIX_TABLE_NAMES) {
      const table = M1_MATRIX_TABLES[name];
      const columns = columnNames(table);
      expect(columns).toContain("id");
      const scope = getTenantTableScope(name);
      if (scope === "global") {
        expect(columns).not.toContain("org_id");
        expect(columns).not.toContain("store_id");
      } else if (scope === "org") {
        expect(columns).toContain("org_id");
      } else {
        expect(columns).toContain("org_id");
        expect(columns).toContain("store_id");
      }
    }
  });

  it("declares store-scope unique tenant id layouts for matrix store tables", () => {
    for (const name of ["staff_store_roles", "store_features", "audit_log"] as const) {
      const config = getTableConfig(M1_MATRIX_TABLES[name]);
      const hasTenantUnique = config.indexes.some((index) => {
        const cols = index.config.columns.map((column) => {
          if (typeof column === "string") return column;
          if ("name" in column && typeof column.name === "string") return column.name;
          return "";
        });
        return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
      });
      expect(hasTenantUnique, `${name} needs UNIQUE(org_id, store_id, id)`).toBe(true);
    }
  });

  it("includes A5 session tables with store tenant columns", () => {
    expect(Object.keys(M1_SESSION_TABLES).sort()).toEqual([...M1_SESSION_TABLE_NAMES].sort());
    for (const name of M1_SESSION_TABLE_NAMES) {
      const columns = columnNames(M1_SESSION_TABLES[name]);
      expect(columns).toContain("org_id");
      expect(columns).toContain("store_id");
      expect(columns).toContain("id");
    }
  });

  it("exposes GUC constants matching A3 / ADR-02", () => {
    expect(APP_ORG_ID_GUC).toBe("app.org_id");
    expect(APP_STORE_ID_GUC).toBe("app.store_id");
    expect(APP_STAFF_ID_GUC).toBe("app.staff_id");
  });

  it("uses formal role names with NOBYPASSRLS intent encoded in migrations", () => {
    expect(LAUNDRY_OWNER_ROLE).toBe("laundry_owner");
    expect(LAUNDRY_APP_ROLE).toBe("laundry_app");
  });

  it("builds RLS SQL using A3 predicates and FORCE RLS", () => {
    const sql = buildM1RlsMigrationSql();
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("NULLIF(current_setting('app.org_id', true), '')::uuid");
    expect(sql).toContain("NULLIF(current_setting('app.store_id', true), '')::uuid");
    expect(sql).toContain('"laundry_app"');
    expect(sql).toContain('"laundry_owner"');
    expect(sql).toContain("audit_log");
    expect(sql).toContain("sessions");
    expect(sql).toContain("pin_lockouts");
    expect(sql).not.toContain("better-sqlite3");
  });

  it("lists a stable full M1 table set", () => {
    expect(M1_ALL_TABLE_NAMES).toEqual([...M1_MATRIX_TABLE_NAMES, ...M1_SESSION_TABLE_NAMES]);
  });

  it("exports M2 order skeleton tables with store tenant columns", () => {
    expect(Object.keys(M2_ORDER_TABLES).sort()).toEqual([...M2_ORDER_TABLE_NAMES].sort());
    expect([...M2_ORDER_RLS_TABLES].sort()).toEqual([...M2_ORDER_TABLE_NAMES].sort());

    for (const name of ["orders", "order_lines", "garments"] as const) {
      const columns = columnNames(M2_ORDER_TABLES[name]);
      expect(columns).toContain("org_id");
      expect(columns).toContain("store_id");
      expect(columns).toContain("id");
    }

    const counterCols = columnNames(M2_ORDER_TABLES.ticket_counters);
    expect(counterCols).toContain("org_id");
    expect(counterCols).toContain("store_id");
    expect(counterCols).toContain("day_key");
    expect(counterCols).toContain("last_seq");
    expect(counterCols).not.toContain("id");
  });

  it("declares M2 tenant unique layouts for order graph FKs", () => {
    const ordersConfig = getTableConfig(M2_ORDER_TABLES.orders);
    const hasOrdersTenantUnique = ordersConfig.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    expect(hasOrdersTenantUnique).toBe(true);

    const linesConfig = getTableConfig(M2_ORDER_TABLES.order_lines);
    const hasLinesTenantUnique = linesConfig.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return (
        cols[0] === "org_id" &&
        cols[1] === "store_id" &&
        cols.includes("order_id") &&
        cols.includes("id")
      );
    });
    expect(hasLinesTenantUnique).toBe(true);

    const garmentsConfig = getTableConfig(M2_ORDER_TABLES.garments);
    const hasGarmentsTenantUnique = garmentsConfig.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    expect(hasGarmentsTenantUnique).toBe(true);
  });

  it("exports M2 catalog tables with store tenant columns", () => {
    expect(Object.keys(M2_CATALOG_TABLES).sort()).toEqual([...M2_CATALOG_TABLE_NAMES].sort());
    expect([...M2_CATALOG_RLS_TABLES].sort()).toEqual([...M2_CATALOG_TABLE_NAMES].sort());

    const columns = columnNames(M2_CATALOG_TABLES.catalog_items);
    expect(columns).toContain("org_id");
    expect(columns).toContain("store_id");
    expect(columns).toContain("id");
    expect(columns).toContain("code");
    expect(columns).toContain("unit_price_cents");
    expect(columns).toContain("mnemonic");
    expect(columns).toContain("is_active");
    expect(columns).toContain("sort_order");
  });

  it("declares M2 catalog tenant unique layouts", () => {
    const config = getTableConfig(M2_CATALOG_TABLES.catalog_items);
    const indexCols = (index: (typeof config.indexes)[number]): string[] =>
      index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });

    const hasTenantUnique = config.indexes.some((index) => {
      const cols = indexCols(index);
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    expect(hasTenantUnique).toBe(true);

    const hasCodeUnique = config.indexes.some((index) => {
      const cols = indexCols(index);
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("code");
    });
    expect(hasCodeUnique).toBe(true);
  });

  it("exposes full schema as M1 + M2 order + catalog tables", () => {
    const expected = [
      ...M1_ALL_TABLE_NAMES,
      ...M2_ORDER_TABLE_NAMES,
      ...M2_CATALOG_TABLE_NAMES,
    ].sort();
    expect(Object.keys(schema).sort()).toEqual(expected);
  });

  it("no longer defers orders/order_lines/garments/catalog past M2 skeleton", () => {
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("orders");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("order_lines");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("garments");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("catalog_items");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).toContain("payments");
  });
});
