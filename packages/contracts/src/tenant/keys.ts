import { getTenantTableDescriptor, type V2TableName } from "./table-matrix.js";
import { captureOwnDataProperties, capturePrimitiveStringArray } from "./input-snapshot.js";

const TENANT_PREFIX = Object.freeze(["org_id", "store_id"] as const);
const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;

export const STORE_ENTITY_UNIQUE_KEY_COLUMNS = Object.freeze([...TENANT_PREFIX, "id"] as const);
export const ORDER_LINE_UNIQUE_KEY_COLUMNS = Object.freeze([
  ...TENANT_PREFIX,
  "order_id",
  "id",
] as const);

declare const TENANT_UNIQUE_KEY_DESCRIPTOR_BRAND: unique symbol;
declare const TENANT_FOREIGN_KEY_DESCRIPTOR_BRAND: unique symbol;

export type TenantUniqueKeyDescriptor<
  TTable extends V2TableName = V2TableName,
  TColumns extends readonly string[] = readonly string[],
> = Readonly<{
  table: TTable;
  columns: TColumns;
  [TENANT_UNIQUE_KEY_DESCRIPTOR_BRAND]: true;
}>;

export type TenantForeignKeyDescriptor<
  TChildTable extends V2TableName = V2TableName,
  TChildColumns extends readonly string[] = readonly string[],
  TParentTable extends V2TableName = V2TableName,
  TParentColumns extends readonly string[] = readonly string[],
> = Readonly<{
  childTable: TChildTable;
  childColumns: TChildColumns;
  parentTable: TParentTable;
  parentColumns: TParentColumns;
  [TENANT_FOREIGN_KEY_DESCRIPTOR_BRAND]: true;
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

const UNIQUE_KEY_INPUT_KEYS = ["table", "columns"] as const;
const FOREIGN_KEY_INPUT_KEYS = [
  "childTable",
  "childColumns",
  "parentTable",
  "parentColumns",
] as const;

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

const requirePrimitiveString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a primitive string`);
  }
  return value;
};

const requireStoreTable = (table: string, label: string): V2TableName => {
  const descriptor = getTenantTableDescriptor(table);
  if (descriptor.scope !== "store") {
    throw new TypeError(`${label} must be a store-scope table`);
  }
  return descriptor.table;
};

const freezeColumns = <const TColumns extends readonly string[]>(
  columns: TColumns,
): Readonly<TColumns> => Object.freeze([...columns]) as Readonly<TColumns>;

const registeredTenantUniqueKeyDescriptors = new WeakSet<object>();
const registeredTenantForeignKeyDescriptors = new WeakSet<object>();

const registerUniqueKeyDescriptor = <
  const TTable extends V2TableName,
  const TColumns extends readonly string[],
>(
  table: TTable,
  columns: TColumns,
): TenantUniqueKeyDescriptor<TTable, Readonly<TColumns>> => {
  const descriptor = Object.freeze({
    table,
    columns: freezeColumns(columns),
  }) as TenantUniqueKeyDescriptor<TTable, Readonly<TColumns>>;
  registeredTenantUniqueKeyDescriptors.add(descriptor);
  return descriptor;
};

const DECLARED_UNIQUE_KEY_LAYOUTS = Object.freeze({
  orders: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  order_lines: ORDER_LINE_UNIQUE_KEY_COLUMNS,
  garments: STORE_ENTITY_UNIQUE_KEY_COLUMNS,
} as const);

type DeclaredTenantUniqueKeyDescriptor = {
  [TTable in keyof typeof DECLARED_UNIQUE_KEY_LAYOUTS]: TenantUniqueKeyDescriptor<
    TTable,
    (typeof DECLARED_UNIQUE_KEY_LAYOUTS)[TTable]
  >;
}[keyof typeof DECLARED_UNIQUE_KEY_LAYOUTS];

export const defineTenantUniqueKey = (
  input: TenantUniqueKeyInput,
): DeclaredTenantUniqueKeyDescriptor => {
  const captured = captureOwnDataProperties(
    input,
    UNIQUE_KEY_INPUT_KEYS,
    "Tenant unique key input",
  );
  const table = requireStoreTable(
    requirePrimitiveString(captured.table, "Tenant unique key input.table"),
    "Tenant unique key table",
  );
  const columns = capturePrimitiveStringArray(captured.columns, "Tenant unique key columns");
  assertColumns(columns, "Tenant unique key");

  const expectedColumns =
    DECLARED_UNIQUE_KEY_LAYOUTS[table as keyof typeof DECLARED_UNIQUE_KEY_LAYOUTS];
  if (expectedColumns === undefined) {
    throw new TypeError(`No declared tenant unique-key layout for table "${table}"`);
  }
  if (!sameColumns(columns, expectedColumns)) {
    const layout = table === "order_lines" ? "order_lines key" : "store entity key";
    throw new TypeError(`${layout} must be (${expectedColumns.join(", ")})`);
  }

  return registerUniqueKeyDescriptor(table, columns) as DeclaredTenantUniqueKeyDescriptor;
};

const declareForeignKeyLayout = <
  const TChildTable extends V2TableName,
  const TChildColumns extends readonly string[],
  const TParentTable extends V2TableName,
  const TParentColumns extends readonly string[],
>(
  childTable: TChildTable,
  childColumns: TChildColumns,
  parentTable: TParentTable,
  parentColumns: TParentColumns,
): TenantForeignKeyDescriptor<
  TChildTable,
  Readonly<TChildColumns>,
  TParentTable,
  Readonly<TParentColumns>
> => {
  const descriptor = Object.freeze({
    childTable,
    childColumns: freezeColumns(childColumns),
    parentTable,
    parentColumns: freezeColumns(parentColumns),
  }) as TenantForeignKeyDescriptor<
    TChildTable,
    Readonly<TChildColumns>,
    TParentTable,
    Readonly<TParentColumns>
  >;
  registeredTenantForeignKeyDescriptors.add(descriptor);
  return descriptor;
};

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
  paymentsToOrders: declareForeignKeyLayout(
    "payments",
    ["org_id", "store_id", "order_id"],
    "orders",
    STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  ),
});

type DeclaredTenantForeignKeyDescriptor =
  (typeof DECLARED_FOREIGN_KEY_LAYOUTS)[keyof typeof DECLARED_FOREIGN_KEY_LAYOUTS];

const findDeclaredForeignKeyLayout = (
  childTable: V2TableName,
  parentTable: V2TableName,
): DeclaredTenantForeignKeyDescriptor | undefined =>
  Object.values(DECLARED_FOREIGN_KEY_LAYOUTS).find(
    (layout) => layout.childTable === childTable && layout.parentTable === parentTable,
  );

export const defineTenantForeignKey = (
  input: TenantForeignKeyInput,
): DeclaredTenantForeignKeyDescriptor => {
  const captured = captureOwnDataProperties(
    input,
    FOREIGN_KEY_INPUT_KEYS,
    "Tenant foreign key input",
  );
  const childTable = requireStoreTable(
    requirePrimitiveString(captured.childTable, "Tenant foreign key input.childTable"),
    "Foreign key child",
  );
  const parentTable = requireStoreTable(
    requirePrimitiveString(captured.parentTable, "Tenant foreign key input.parentTable"),
    "Foreign key parent",
  );
  const childColumns = capturePrimitiveStringArray(
    captured.childColumns,
    "Tenant foreign key child columns",
  );
  const parentColumns = capturePrimitiveStringArray(
    captured.parentColumns,
    "Tenant foreign key parent columns",
  );

  if (childColumns.length !== parentColumns.length) {
    throw new TypeError("Tenant foreign key child and parent columns must have the same length");
  }
  assertColumns(childColumns, "Tenant foreign key child columns");
  assertColumns(parentColumns, "Tenant foreign key parent columns");

  const declaredLayout = findDeclaredForeignKeyLayout(childTable, parentTable);
  if (declaredLayout === undefined) {
    throw new TypeError(
      `No declared tenant foreign-key layout for ${childTable} -> ${parentTable}`,
    );
  }
  if (
    !sameColumns(childColumns, declaredLayout.childColumns) ||
    !sameColumns(parentColumns, declaredLayout.parentColumns)
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

  return declareForeignKeyLayout(
    childTable,
    childColumns,
    parentTable,
    parentColumns,
  ) as DeclaredTenantForeignKeyDescriptor;
};

export const ORDER_LINES_ORDER_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.orderLinesToOrders;
export const GARMENTS_ORDER_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.garmentsToOrders;
export const GARMENTS_ORDER_LINE_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.garmentsToOrderLines;
export const PAYMENTS_ORDER_FOREIGN_KEY = DECLARED_FOREIGN_KEY_LAYOUTS.paymentsToOrders;

export const isTenantUniqueKeyDescriptor = (
  value: unknown,
): value is DeclaredTenantUniqueKeyDescriptor =>
  typeof value === "object" && value !== null && registeredTenantUniqueKeyDescriptors.has(value);

export const isTenantForeignKeyDescriptor = (
  value: unknown,
): value is DeclaredTenantForeignKeyDescriptor =>
  typeof value === "object" && value !== null && registeredTenantForeignKeyDescriptors.has(value);
