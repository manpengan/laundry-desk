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

const DECLARED_UNIQUE_KEY_LAYOUTS: Readonly<Partial<Record<V2TableName, readonly string[]>>> =
  Object.freeze({
    orders: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
    order_lines: ORDER_LINE_UNIQUE_KEY_COLUMNS,
  });

export const defineTenantUniqueKey = (input: TenantUniqueKeyInput): TenantUniqueKeyDescriptor => {
  const table = requireStoreTable(input.table, "Tenant unique key table").table;
  assertColumns(input.columns, "Tenant unique key");

  const expectedColumns = DECLARED_UNIQUE_KEY_LAYOUTS[table];
  if (expectedColumns === undefined) {
    throw new TypeError(`No declared tenant unique-key layout for table "${table}"`);
  }
  if (!sameColumns(input.columns, expectedColumns)) {
    const layout = table === "order_lines" ? "order_lines key" : "store entity key";
    throw new TypeError(`${layout} must be (${expectedColumns.join(", ")})`);
  }

  return Object.freeze({ table, columns: freezeColumns(input.columns) });
};

const declareForeignKeyLayout = (
  childTable: V2TableName,
  childColumns: readonly string[],
  parentTable: V2TableName,
  parentColumns: readonly string[],
): TenantForeignKeyDescriptor =>
  Object.freeze({
    childTable,
    childColumns: freezeColumns(childColumns),
    parentTable,
    parentColumns: freezeColumns(parentColumns),
  });

const DECLARED_FOREIGN_KEY_LAYOUTS = Object.freeze({
  orderLinesToOrders: declareForeignKeyLayout(
    "order_lines",
    ["org_id", "store_id", "order_id"],
    "orders",
    STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  ),
  garmentsToOrders: declareForeignKeyLayout(
    "garments",
    ["org_id", "store_id", "order_id"],
    "orders",
    STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  ),
  garmentsToOrderLines: declareForeignKeyLayout(
    "garments",
    ["org_id", "store_id", "order_id", "order_line_id"],
    "order_lines",
    ORDER_LINE_UNIQUE_KEY_COLUMNS,
  ),
});

const findDeclaredForeignKeyLayout = (
  childTable: V2TableName,
  parentTable: V2TableName,
): TenantForeignKeyDescriptor | undefined =>
  Object.values(DECLARED_FOREIGN_KEY_LAYOUTS).find(
    (layout) => layout.childTable === childTable && layout.parentTable === parentTable,
  );

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

  const declaredLayout = findDeclaredForeignKeyLayout(childTable, parentTable);
  if (declaredLayout === undefined) {
    throw new TypeError(
      `No declared tenant foreign-key layout for ${childTable} -> ${parentTable}`,
    );
  }
  if (
    !sameColumns(input.childColumns, declaredLayout.childColumns) ||
    !sameColumns(input.parentColumns, declaredLayout.parentColumns)
  ) {
    if (childTable === "garments" && parentTable === "order_lines") {
      throw new TypeError(
        "order_lines foreign key must use the exact garments -> order_lines layout " +
          "(org_id, store_id, order_id, order_line_id) -> (org_id, store_id, order_id, id)",
      );
    }
    throw new TypeError(
      `cross-parent foreign key layout for ${childTable} -> ${parentTable}; expected ` +
        `(${declaredLayout.childColumns.join(", ")}) -> ` +
        `(${declaredLayout.parentColumns.join(", ")})`,
    );
  }

  return Object.freeze({
    childTable,
    childColumns: freezeColumns(input.childColumns),
    parentTable,
    parentColumns: freezeColumns(input.parentColumns),
  });
};

export const ORDER_LINES_ORDER_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.orderLinesToOrders;
export const GARMENTS_ORDER_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.garmentsToOrders;
export const GARMENTS_ORDER_LINE_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.garmentsToOrderLines;
