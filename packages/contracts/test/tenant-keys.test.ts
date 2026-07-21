import { describe, expect, it } from "vitest";

import {
  GARMENTS_ORDER_FOREIGN_KEY,
  GARMENTS_ORDER_LINE_FOREIGN_KEY,
  ORDER_LINES_ORDER_FOREIGN_KEY,
  ORDER_LINE_UNIQUE_KEY_COLUMNS,
  PAYMENTS_ORDER_FOREIGN_KEY,
  STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  defineTenantForeignKey,
  defineTenantUniqueKey,
  isTenantForeignKeyDescriptor,
  isTenantUniqueKeyDescriptor,
} from "../src/index.js";

type RuntimeKeyFactory = (input: unknown) => unknown;

const runtimeDefineTenantUniqueKey = defineTenantUniqueKey as RuntimeKeyFactory;
const runtimeDefineTenantForeignKey = defineTenantForeignKey as RuntimeKeyFactory;

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

  it("accepts the garments entity key declared by the M0-1 schema", () => {
    expect(
      defineTenantUniqueKey({ table: "garments", columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS }),
    ).toEqual({ table: "garments", columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS });
  });

  it("rejects non-store entity tables", () => {
    expect(() =>
      defineTenantUniqueKey({ table: "customers", columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS }),
    ).toThrowError("store-scope table");
  });

  it("rejects an id-based key for a store table without a declared entity layout", () => {
    expect(() =>
      defineTenantUniqueKey({
        table: "primary_lease_heads",
        columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
      }),
    ).toThrowError('No declared tenant unique-key layout for table "primary_lease_heads"');
  });

  it("rejects a changing table accessor without invoking it", () => {
    let reads = 0;
    const input = {
      columns: ["org_id", "store_id", "id"],
    } as Record<string, unknown>;
    Object.defineProperty(input, "table", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "orders" : "garments";
      },
    });

    expect(() => runtimeDefineTenantUniqueKey(input)).toThrowError("own data property");
    expect(reads).toBe(0);
  });

  it.each([
    [null, "plain object"],
    [{ table: "orders" }, "exactly the properties"],
    [
      { table: "orders", columns: ["org_id", "store_id", "id"], extra: true },
      "exactly the properties",
    ],
    [{ table: new String("orders"), columns: ["org_id", "store_id", "id"] }, "primitive string"],
    [{ table: "orders", columns: "org_id,store_id,id" }, "plain string array"],
  ] as const)("rejects malformed unique-key input %#", (input, error) => {
    expect(() => runtimeDefineTenantUniqueKey(input)).toThrowError(error);
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
    expect(PAYMENTS_ORDER_FOREIGN_KEY).toEqual({
      childTable: "payments",
      childColumns: ["org_id", "store_id", "order_id"],
      parentTable: "orders",
      parentColumns: ["org_id", "store_id", "id"],
    });
    expect(Object.isFrozen(PAYMENTS_ORDER_FOREIGN_KEY)).toBe(true);
    expect(Object.isFrozen(GARMENTS_ORDER_LINE_FOREIGN_KEY)).toBe(true);
    expect(Object.isFrozen(GARMENTS_ORDER_LINE_FOREIGN_KEY.childColumns)).toBe(true);
    expect(Object.isFrozen(GARMENTS_ORDER_LINE_FOREIGN_KEY.parentColumns)).toBe(true);
  });

  it("returns immutable copies without mutating caller input", () => {
    const childColumns = ["org_id", "store_id", "order_id"];
    const parentColumns = ["org_id", "store_id", "id"];
    const descriptor = defineTenantForeignKey({
      childTable: "order_lines",
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
        childTable: "order_lines",
        childColumns: ["org_id", "store_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "same length",
    ],
    [
      {
        childTable: "order_lines",
        childColumns: ["store_id", "org_id", "order_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "ordered tenant prefix",
    ],
    [
      {
        childTable: "order_lines",
        childColumns: ["org_id", "store_id", "store_id"],
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      },
      "duplicate column",
    ],
    [
      {
        childTable: "order_lines",
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

  it("accepts the payments order reference declared by architecture section 7", () => {
    expect(
      defineTenantForeignKey({
        childTable: "payments",
        childColumns: ["org_id", "store_id", "order_id"],
        parentTable: "orders",
        parentColumns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
      }),
    ).toEqual({
      childTable: "payments",
      childColumns: ["org_id", "store_id", "order_id"],
      parentTable: "orders",
      parentColumns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
    });
  });

  it.each([
    ["garment_status_log", ["org_id", "store_id", "garment_id"], "garments"],
    ["print_jobs", ["org_id", "store_id", "order_id"], "orders"],
    ["ticket_no_blocks", ["org_id", "store_id", "device_id"], "devices"],
  ] as const)(
    "does not infer the ambiguous %s parent mapping",
    (childTable, childColumns, parentTable) => {
      expect(() =>
        defineTenantForeignKey({
          childTable,
          childColumns,
          parentTable,
          parentColumns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
        }),
      ).toThrowError(`No declared tenant foreign-key layout for ${childTable} -> ${parentTable}`);
    },
  );

  it("proves key descriptor provenance instead of trusting structural clones", () => {
    const uniqueKey = defineTenantUniqueKey({
      table: "orders",
      columns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
    });
    const foreignKey = defineTenantForeignKey({
      childTable: "payments",
      childColumns: ["org_id", "store_id", "order_id"],
      parentTable: "orders",
      parentColumns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
    });

    expect(isTenantUniqueKeyDescriptor(uniqueKey)).toBe(true);
    expect(isTenantUniqueKeyDescriptor({ ...uniqueKey })).toBe(false);
    expect(isTenantUniqueKeyDescriptor(JSON.parse(JSON.stringify(uniqueKey)))).toBe(false);
    expect(isTenantForeignKeyDescriptor(foreignKey)).toBe(true);
    expect(isTenantForeignKeyDescriptor(PAYMENTS_ORDER_FOREIGN_KEY)).toBe(true);
    expect(isTenantForeignKeyDescriptor({ ...foreignKey })).toBe(false);
    expect(isTenantForeignKeyDescriptor(JSON.parse(JSON.stringify(foreignKey)))).toBe(false);
  });

  it("rejects changing foreign-key property accessors without invoking them", () => {
    let tableReads = 0;
    let columnReads = 0;
    const input = {
      parentTable: "orders",
      parentColumns: ["org_id", "store_id", "id"],
    } as Record<string, unknown>;
    Object.defineProperties(input, {
      childTable: {
        enumerable: true,
        get: () => {
          tableReads += 1;
          return tableReads === 1 ? "payments" : "garments";
        },
      },
      childColumns: {
        enumerable: true,
        get: () => {
          columnReads += 1;
          return columnReads < 4
            ? ["org_id", "store_id", "order_id"]
            : ["org_id", "store_id", "garment_id"];
        },
      },
    });

    expect(() => runtimeDefineTenantForeignKey(input)).toThrowError("own data property");
    expect(tableReads).toBe(0);
    expect(columnReads).toBe(0);
  });

  it("rejects accessor-bearing column arrays without invoking an index getter", () => {
    let reads = 0;
    const childColumns = ["org_id", "store_id", "order_id"];
    Object.defineProperty(childColumns, "2", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "order_id" : "garment_id";
      },
    });

    expect(() =>
      runtimeDefineTenantForeignKey({
        childTable: "payments",
        childColumns,
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      }),
    ).toThrowError("array index 2 must be an own data property");
    expect(reads).toBe(0);
  });

  it("uses one descriptor snapshot for a Proxy-backed column array", () => {
    let indexReads = 0;
    const childColumns = new Proxy(["org_id", "store_id", "order_id"], {
      get: (target, property, receiver) => {
        if (property === "2") {
          indexReads += 1;
          return indexReads === 1 ? "order_id" : "garment_id";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const descriptor = runtimeDefineTenantForeignKey({
      childTable: "payments",
      childColumns,
      parentTable: "orders",
      parentColumns: ["org_id", "store_id", "id"],
    });

    expect(indexReads).toBe(0);
    expect(descriptor).toEqual(PAYMENTS_ORDER_FOREIGN_KEY);
  });

  it("rejects an oversized Proxy array length before allocating index keys", () => {
    let lengthDescriptorReads = 0;
    const childColumns = new Proxy<string[]>([], {
      getOwnPropertyDescriptor: (target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "length" && descriptor !== undefined) {
          lengthDescriptorReads += 1;
          return { ...descriptor, value: 100_000 };
        }
        return descriptor;
      },
    });

    expect(() =>
      runtimeDefineTenantForeignKey({
        childTable: "payments",
        childColumns,
        parentTable: "orders",
        parentColumns: ["org_id", "store_id", "id"],
      }),
    ).toThrowError("must contain at most 4 entries");
    expect(lengthDescriptorReads).toBe(1);
  });
});
