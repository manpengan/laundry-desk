import { describe, expect, it } from "vitest";

import {
  GARMENTS_ORDER_FOREIGN_KEY,
  GARMENTS_ORDER_LINE_FOREIGN_KEY,
  ORDER_LINES_ORDER_FOREIGN_KEY,
  ORDER_LINE_UNIQUE_KEY_COLUMNS,
  STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  defineTenantForeignKey,
  defineTenantUniqueKey,
} from "../src/index.js";

describe("A3 tenant composite unique keys", () => {
  it("freezes the canonical store entity and order-line identities", () => {
    expect(STORE_ENTITY_UNIQUE_KEY_COLUMNS).toEqual(["org_id", "store_id", "id"]);
    expect(ORDER_LINE_UNIQUE_KEY_COLUMNS).toEqual(["org_id", "store_id", "order_id", "id"]);
    expect(Object.isFrozen(STORE_ENTITY_UNIQUE_KEY_COLUMNS)).toBe(true);
    expect(Object.isFrozen(ORDER_LINE_UNIQUE_KEY_COLUMNS)).toBe(true);
  });

  it("returns a frozen defensive copy for valid layouts", () => {
    const columns = ["org_id", "store_id", "id"];
    const descriptor = defineTenantUniqueKey({ table: "orders", columns });
    columns[2] = "other_id";

    expect(descriptor).toEqual({ table: "orders", columns: ["org_id", "store_id", "id"] });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.columns)).toBe(true);
  });

  it.each([
    [["store_id", "org_id", "id"], "ordered tenant prefix"],
    [["org_id", "id"], "ordered tenant prefix"],
    [["org_id", "store_id", "store_id"], "duplicate column"],
    [["org_id", "store_id", "order_id"], "store entity key"],
  ] as const)("rejects invalid store entity columns %j", (columns, message) => {
    expect(() => defineTenantUniqueKey({ table: "orders", columns })).toThrowError(message);
  });

  it("requires order_lines identity to retain its order parent", () => {
    expect(
      defineTenantUniqueKey({ table: "order_lines", columns: ORDER_LINE_UNIQUE_KEY_COLUMNS }),
    ).toEqual({ table: "order_lines", columns: ORDER_LINE_UNIQUE_KEY_COLUMNS });
    expect(() =>
      defineTenantUniqueKey({
        table: "order_lines",
        columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
      }),
    ).toThrowError("order_lines key");
  });

  it("rejects non-store entity tables", () => {
    expect(() =>
      defineTenantUniqueKey({ table: "customers", columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS }),
    ).toThrowError("store-scope table");
  });
});

describe("A3 tenant composite foreign keys", () => {
  it("freezes the canonical order and garment reference descriptors", () => {
    expect(ORDER_LINES_ORDER_FOREIGN_KEY).toEqual({
      childTable: "order_lines",
      childColumns: ["org_id", "store_id", "order_id"],
      parentTable: "orders",
      parentColumns: ["org_id", "store_id", "id"],
    });
    expect(GARMENTS_ORDER_FOREIGN_KEY).toEqual({
      childTable: "garments",
      childColumns: ["org_id", "store_id", "order_id"],
      parentTable: "orders",
      parentColumns: ["org_id", "store_id", "id"],
    });
    expect(GARMENTS_ORDER_LINE_FOREIGN_KEY).toEqual({
      childTable: "garments",
      childColumns: ["org_id", "store_id", "order_id", "order_line_id"],
      parentTable: "order_lines",
      parentColumns: ["org_id", "store_id", "order_id", "id"],
    });
    expect(Object.isFrozen(GARMENTS_ORDER_LINE_FOREIGN_KEY)).toBe(true);
    expect(Object.isFrozen(GARMENTS_ORDER_LINE_FOREIGN_KEY.childColumns)).toBe(true);
    expect(Object.isFrozen(GARMENTS_ORDER_LINE_FOREIGN_KEY.parentColumns)).toBe(true);
  });

  it("returns immutable copies without mutating caller input", () => {
    const childColumns = ["org_id", "store_id", "order_id"];
    const parentColumns = ["org_id", "store_id", "id"];
    const descriptor = defineTenantForeignKey({
      childTable: "payments",
      childColumns,
      parentTable: "orders",
      parentColumns,
    });
    childColumns[2] = "garment_id";
    parentColumns.reverse();

    expect(descriptor.childColumns).toEqual(["org_id", "store_id", "order_id"]);
    expect(descriptor.parentColumns).toEqual(["org_id", "store_id", "id"]);
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it.each([
    [
      {
        childTable: "payments",
        childColumns: ["org_id", "store_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "same length",
    ],
    [
      {
        childTable: "payments",
        childColumns: ["store_id", "org_id", "order_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "ordered tenant prefix",
    ],
    [
      {
        childTable: "payments",
        childColumns: ["org_id", "store_id", "store_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "duplicate column",
    ],
    [
      {
        childTable: "payments",
        childColumns: ["org_id", "store_id", "garment_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "cross-parent",
    ],
  ] as const)("rejects malformed foreign-key layouts", (input, message) => {
    expect(() => defineTenantForeignKey(input)).toThrowError(message);
  });

  it("rejects an order_lines reference that omits order_id", () => {
    expect(() =>
      defineTenantForeignKey({
        childTable: "garments",
        childColumns: ["org_id", "store_id", "order_line_id"],
        parentTable: "order_lines",
        parentColumns: ["org_id", "store_id", "id"],
      }),
    ).toThrowError("exact garments -> order_lines layout");
  });

  it("rejects an order parent represented with an order-line parent key", () => {
    expect(() =>
      defineTenantForeignKey({
        childTable: "garments",
        childColumns: ["org_id", "store_id", "order_id", "order_line_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "order_id", "id"],
      }),
    ).toThrowError("cross-parent");
  });
});
