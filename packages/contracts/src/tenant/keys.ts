import {
  getTenantTableDescriptor,
  type TenantTableDescriptor,
  type V2TableName,
} from "./table-matrix.js";

const TENANT_PREFIX = Object.freeze(["org_id", "store_id"] as const);
const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;

export const STORE_ENTITY_UNIQUE_KEY_COLUMNS = Object.freeze([...TENANT_PREFIX, "id"] as const);
export const ORDER_LINE_UNIQUE_KEY_COLUMNS = Object.freeze([
  ...TENANT_PREFIX,
  "order_id",
  "id",
] as const);

export type TenantUniqueKeyDescriptor = Readonly<{
  table: V2TableName;
  columns: readonly string[];
}>;

export type TenantForeignKeyDescriptor = Readonly<{
  childTable: V2TableName;
  childColumns: readonly string[];
  parentTable: V2TableName;
  parentColumns: readonly string[];
}>;

type TenantUniqueKeyInput = Readonly<{
  table: string;
  columns: readonly string[];
}>;

type TenantForeignKeyInput = Readonly<{
  childTable: string;
  childColumns: readonly string[];
  parentTable: string;
  parentColumns: readonly string[];
}>;

const sameColumns = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((column, index) => column === expected[index]);

const assertColumns = (columns: readonly string[], label: string): void => {
  if (columns.some((column) => !COLUMN_NAME.test(column))) {
    throw new TypeError(`${label} contains an invalid column name`);
  }
  if (new Set(columns).size !== columns.length) {
    throw new TypeError(`${label} contains a duplicate column`);
  }
  if (columns[0] !== TENANT_PREFIX[0] || columns[1] !== TENANT_PREFIX[1]) {
    throw new TypeError(
      `${label} must start with the exact ordered tenant prefix org_id, store_id`,
    );
  }
};

const requireStoreTable = (table: string, label: string): TenantTableDescriptor<V2TableName> => {
  const descriptor = getTenantTableDescriptor(table);
  if (descriptor.scope !== "store") {
    throw new TypeError(`${label} must be a store-scope table`);
  }
  return descriptor;
};

const freezeColumns = (columns: readonly string[]): readonly string[] =>
  Object.freeze([...columns]);

export const defineTenantUniqueKey = (input: TenantUniqueKeyInput): TenantUniqueKeyDescriptor => {
  const table = requireStoreTable(input.table, "Tenant unique key table").table;
  assertColumns(input.columns, "Tenant unique key");

  const expectedColumns =
    table === "order_lines" ? ORDER_LINE_UNIQUE_KEY_COLUMNS : STORE_ENTITY_UNIQUE_KEY_COLUMNS;
  if (!sameColumns(input.columns, expectedColumns)) {
    const layout = table === "order_lines" ? "order_lines key" : "store entity key";
    throw new TypeError(`${layout} must be (${expectedColumns.join(", ")})`);
  }

  return Object.freeze({ table, columns: freezeColumns(input.columns) });
};

const referenceColumnFor = (parentTable: V2TableName): string => {
  const singularParent = parentTable.endsWith("ies")
    ? `${parentTable.slice(0, -3)}y`
    : parentTable.endsWith("s")
      ? parentTable.slice(0, -1)
      : parentTable;
  return `${singularParent}_id`;
};

const assertOrderLineReference = (input: TenantForeignKeyInput): void => {
  const expectedChildColumns = ["org_id", "store_id", "order_id", "order_line_id"];
  if (
    input.childTable !== "garments" ||
    !sameColumns(input.childColumns, expectedChildColumns) ||
    !sameColumns(input.parentColumns, ORDER_LINE_UNIQUE_KEY_COLUMNS)
  ) {
    throw new TypeError(
      "order_lines foreign key must use the exact garments -> order_lines layout " +
        "(org_id, store_id, order_id, order_line_id) -> (org_id, store_id, order_id, id)",
    );
  }
};

const assertStoreParentReference = (
  input: TenantForeignKeyInput,
  parentTable: V2TableName,
): void => {
  const expectedChildColumns = [...TENANT_PREFIX, referenceColumnFor(parentTable)];
  if (
    !sameColumns(input.childColumns, expectedChildColumns) ||
    !sameColumns(input.parentColumns, STORE_ENTITY_UNIQUE_KEY_COLUMNS)
  ) {
    throw new TypeError(
      `cross-parent foreign key layout for ${input.childTable} -> ${parentTable}; expected ` +
        `(${expectedChildColumns.join(", ")}) -> (${STORE_ENTITY_UNIQUE_KEY_COLUMNS.join(", ")})`,
    );
  }
};

export const defineTenantForeignKey = (
  input: TenantForeignKeyInput,
): TenantForeignKeyDescriptor => {
  const childTable = requireStoreTable(input.childTable, "Foreign key child").table;
  const parentTable = requireStoreTable(input.parentTable, "Foreign key parent").table;

  if (input.childColumns.length !== input.parentColumns.length) {
    throw new TypeError("Tenant foreign key child and parent columns must have the same length");
  }
  assertColumns(input.childColumns, "Tenant foreign key child columns");
  assertColumns(input.parentColumns, "Tenant foreign key parent columns");

  if (parentTable === "order_lines") {
    assertOrderLineReference(input);
  } else {
    assertStoreParentReference(input, parentTable);
  }

  return Object.freeze({
    childTable,
    childColumns: freezeColumns(input.childColumns),
    parentTable,
    parentColumns: freezeColumns(input.parentColumns),
  });
};

export const ORDER_LINES_ORDER_FOREIGN_KEY = defineTenantForeignKey({
  childTable: "order_lines",
  childColumns: ["org_id", "store_id", "order_id"],
  parentTable: "orders",
  parentColumns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
});

export const GARMENTS_ORDER_FOREIGN_KEY = defineTenantForeignKey({
  childTable: "garments",
  childColumns: ["org_id", "store_id", "order_id"],
  parentTable: "orders",
  parentColumns: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
});

export const GARMENTS_ORDER_LINE_FOREIGN_KEY = defineTenantForeignKey({
  childTable: "garments",
  childColumns: ["org_id", "store_id", "order_id", "order_line_id"],
  parentTable: "order_lines",
  parentColumns: ORDER_LINE_UNIQUE_KEY_COLUMNS,
});
