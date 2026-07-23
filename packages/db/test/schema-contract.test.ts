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
  M2_PAYMENT_RLS_TABLES,
  M2_PAYMENT_TABLE_NAMES,
  M2_PAYMENT_TABLES,
  M2_PRINT_RLS_TABLES,
  M2_PRINT_TABLE_NAMES,
  M2_PRINT_TABLES,
  M2_CUSTOMER_RLS_TABLES,
  M2_CUSTOMER_TABLE_NAMES,
  M2_CUSTOMER_TABLES,
  M2_SHIFT_RLS_TABLES,
  M2_SHIFT_TABLE_NAMES,
  M2_SHIFT_TABLES,
  M3_PHOTO_RLS_TABLES,
  M3_PHOTO_TABLE_NAMES,
  M3_PHOTO_TABLES,
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

  it("exports M2 payments tables with store tenant columns and ledger fields", () => {
    expect(Object.keys(M2_PAYMENT_TABLES).sort()).toEqual([...M2_PAYMENT_TABLE_NAMES].sort());
    expect([...M2_PAYMENT_RLS_TABLES].sort()).toEqual([...M2_PAYMENT_TABLE_NAMES].sort());

    const columns = columnNames(M2_PAYMENT_TABLES.payments);
    expect(columns).toContain("org_id");
    expect(columns).toContain("store_id");
    expect(columns).toContain("id");
    expect(columns).toContain("order_id");
    expect(columns).toContain("method");
    expect(columns).toContain("amount_cents");
    expect(columns).toContain("kind");
    expect(columns).toContain("ref_payment_id");
    expect(columns).toContain("staff_id");
    expect(columns).toContain("at");
  });

  it("declares M2 payments tenant unique layout", () => {
    const config = getTableConfig(M2_PAYMENT_TABLES.payments);
    const hasTenantUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    expect(hasTenantUnique).toBe(true);
  });

  it("exports M2 print_jobs with store tenant columns and process fields", () => {
    expect(Object.keys(M2_PRINT_TABLES).sort()).toEqual([...M2_PRINT_TABLE_NAMES].sort());
    expect([...M2_PRINT_RLS_TABLES].sort()).toEqual([...M2_PRINT_TABLE_NAMES].sort());

    const columns = columnNames(M2_PRINT_TABLES.print_jobs);
    expect(columns).toContain("org_id");
    expect(columns).toContain("store_id");
    expect(columns).toContain("id");
    expect(columns).toContain("order_id");
    expect(columns).toContain("ticket_no");
    expect(columns).toContain("kind");
    expect(columns).toContain("status");
    expect(columns).toContain("error");
    expect(columns).toContain("payload_bytes");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("declares M2 print_jobs tenant unique layout", () => {
    const config = getTableConfig(M2_PRINT_TABLES.print_jobs);
    const hasTenantUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    expect(hasTenantUnique).toBe(true);
  });

  it("exports M2 customers with org tenant columns and phone unique layout", () => {
    expect(Object.keys(M2_CUSTOMER_TABLES).sort()).toEqual([...M2_CUSTOMER_TABLE_NAMES].sort());
    expect([...M2_CUSTOMER_RLS_TABLES].sort()).toEqual([...M2_CUSTOMER_TABLE_NAMES].sort());

    const columns = columnNames(M2_CUSTOMER_TABLES.customers);
    expect(columns).toContain("org_id");
    expect(columns).toContain("id");
    expect(columns).toContain("phone");
    expect(columns).toContain("name");
    expect(columns).toContain("note");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
    expect(columns).not.toContain("store_id");
    expect(getTenantTableScope("customers")).toBe("org");
  });

  it("declares M2 customers org+id and org+phone unique layout", () => {
    const config = getTableConfig(M2_CUSTOMER_TABLES.customers);
    const hasOrgIdUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "id";
    });
    const hasOrgPhoneUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "phone";
    });
    expect(hasOrgIdUnique).toBe(true);
    expect(hasOrgPhoneUnique).toBe(true);
  });

  it("exports M2 shift_closings with store tenant columns and snapshot fields", () => {
    expect(Object.keys(M2_SHIFT_TABLES).sort()).toEqual([...M2_SHIFT_TABLE_NAMES].sort());
    expect([...M2_SHIFT_RLS_TABLES].sort()).toEqual([...M2_SHIFT_TABLE_NAMES].sort());

    const columns = columnNames(M2_SHIFT_TABLES.shift_closings);
    expect(columns).toContain("org_id");
    expect(columns).toContain("store_id");
    expect(columns).toContain("id");
    expect(columns).toContain("business_date");
    expect(columns).toContain("closed_by_staff_id");
    expect(columns).toContain("note");
    expect(columns).toContain("order_count");
    expect(columns).toContain("payable_cents");
    expect(columns).toContain("paid_cents");
    expect(columns).toContain("payment_cents");
    expect(columns).toContain("signature_name");
    expect(columns).toContain("closed_at");
    expect(getTenantTableScope("shift_closings")).toBe("store");
  });

  it("declares M2 shift_closings tenant unique and business_date unique layout", () => {
    const config = getTableConfig(M2_SHIFT_TABLES.shift_closings);
    const hasTenantUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    const hasDateUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("business_date");
    });
    expect(hasTenantUnique).toBe(true);
    expect(hasDateUnique).toBe(true);
  });

  it("exports M3 garment_photos with store tenant columns and metadata fields", () => {
    expect(Object.keys(M3_PHOTO_TABLES).sort()).toEqual([...M3_PHOTO_TABLE_NAMES].sort());
    expect([...M3_PHOTO_RLS_TABLES].sort()).toEqual([...M3_PHOTO_TABLE_NAMES].sort());

    const columns = columnNames(M3_PHOTO_TABLES.garment_photos);
    expect(columns).toContain("org_id");
    expect(columns).toContain("store_id");
    expect(columns).toContain("id");
    expect(columns).toContain("garment_id");
    expect(columns).toContain("order_id");
    expect(columns).toContain("kind");
    expect(columns).toContain("storage_key");
    expect(columns).toContain("content_type");
    expect(columns).toContain("byte_size");
    expect(columns).toContain("taken_at");
    expect(columns).toContain("created_by_staff_id");
    expect(getTenantTableScope("garment_photos")).toBe("store");
  });

  it("declares M3 garment_photos tenant unique layout", () => {
    const config = getTableConfig(M3_PHOTO_TABLES.garment_photos);
    const hasTenantUnique = config.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return cols[0] === "org_id" && cols[1] === "store_id" && cols.includes("id");
    });
    expect(hasTenantUnique).toBe(true);
  });

  it("binds each photo to a garment in the same tenant and order", () => {
    const garmentConfig = getTableConfig(M2_ORDER_TABLES.garments);
    const hasOrderGarmentUnique = garmentConfig.indexes.some((index) => {
      const cols = index.config.columns.map((column) => {
        if (typeof column === "string") return column;
        if ("name" in column && typeof column.name === "string") return column.name;
        return "";
      });
      return (
        cols[0] === "org_id" && cols[1] === "store_id" && cols[2] === "order_id" && cols[3] === "id"
      );
    });
    expect(hasOrderGarmentUnique).toBe(true);

    const photoConfig = getTableConfig(M3_PHOTO_TABLES.garment_photos);
    expect(
      photoConfig.foreignKeys.some((fk) => fk.getName() === "garment_photos_garment_order_fk"),
    ).toBe(true);
  });

  it("exposes full schema as M1 + M2 + M3 garment_photos tables", () => {
    const expected = [
      ...M1_ALL_TABLE_NAMES,
      ...M2_ORDER_TABLE_NAMES,
      ...M2_CATALOG_TABLE_NAMES,
      ...M2_PAYMENT_TABLE_NAMES,
      ...M2_PRINT_TABLE_NAMES,
      ...M2_CUSTOMER_TABLE_NAMES,
      ...M2_SHIFT_TABLE_NAMES,
      ...M3_PHOTO_TABLE_NAMES,
    ].sort();
    expect(Object.keys(schema).sort()).toEqual(expected);
  });

  it("no longer defers orders/catalog/payments/print/customers/shift/photos past skeleton", () => {
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("orders");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("order_lines");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("garments");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("catalog_items");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("payments");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("print_jobs");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("customers");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("shift_closings");
    expect(DEFERRED_V2_TABLES_NOTE.deferredExamples).not.toContain("garment_photos");
  });
});
