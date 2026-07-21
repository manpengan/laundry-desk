import {
  getTenantTableDescriptor,
  type OrgScopeTableName,
  type StoreScopeTableName,
  type V2TableName,
} from "./table-matrix.js";

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export const ORG_TENANT_PREDICATE_SQL =
  "org_id = NULLIF(current_setting('app.org_id', true), '')::uuid";
export const STORE_TENANT_PREDICATE_SQL = `${ORG_TENANT_PREDICATE_SQL}
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid`;

export type TenantPolicySqlInput<TTable extends V2TableName = V2TableName> = Readonly<{
  schema: string;
  table: TTable;
  policy: string;
  role: string;
}>;

type MaintenancePolicySqlInput = Readonly<{
  schema: string;
  table: string;
  policy: string;
  maintenanceRole: string;
}>;

const quoteIdentifier = (identifier: string, label: string): string => {
  if (!SQL_IDENTIFIER.test(identifier)) {
    throw new TypeError(`Invalid SQL ${label} identifier`);
  }
  return `"${identifier}"`;
};

const qualifiedTable = (schema: string, table: string): string =>
  `${quoteIdentifier(schema, "schema")}.${quoteIdentifier(table, "table")}`;

const requireTenantTableScope = (table: string, expectedScope: "org" | "store"): void => {
  const descriptor = getTenantTableDescriptor(table);
  if (descriptor.scope === "global") {
    throw new TypeError(`Tenant RLS policy cannot target global-scope table "${table}"`);
  }
  if (descriptor.scope !== expectedScope) {
    const article = expectedScope === "org" ? "an" : "a";
    throw new TypeError(
      `Tenant RLS policy requires ${article} ${expectedScope}-scope table; ` +
        `matrix declares "${table}" as ${descriptor.scope}-scope`,
    );
  }
};

const buildTenantPolicySql = (
  input: TenantPolicySqlInput,
  predicate: string,
  expectedScope: "org" | "store",
): string => {
  const table = qualifiedTable(input.schema, input.table);
  const policy = quoteIdentifier(input.policy, "policy");
  const role = quoteIdentifier(input.role, "role");
  requireTenantTableScope(input.table, expectedScope);

  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${policy} ON ${table}
  AS PERMISSIVE
  FOR ALL
  TO ${role}
  USING (${predicate})
  WITH CHECK (${predicate});`;
};

export const buildOrgTenantPolicySql = (input: TenantPolicySqlInput<OrgScopeTableName>): string =>
  buildTenantPolicySql(input, ORG_TENANT_PREDICATE_SQL, "org");

export const buildStoreTenantPolicySql = (
  input: TenantPolicySqlInput<StoreScopeTableName>,
): string => buildTenantPolicySql(input, STORE_TENANT_PREDICATE_SQL, "store");

export const buildMaintenancePolicySql = (input: MaintenancePolicySqlInput): string => {
  const table = qualifiedTable(input.schema, input.table);
  const policy = quoteIdentifier(input.policy, "policy");
  const maintenanceRole = quoteIdentifier(input.maintenanceRole, "maintenance role");
  if (input.maintenanceRole !== "laundry_owner") {
    throw new TypeError("Maintenance policy role must be laundry_owner");
  }

  return `CREATE POLICY ${policy} ON ${table}
  AS PERMISSIVE
  FOR ALL
  TO ${maintenanceRole}
  USING (true)
  WITH CHECK (true);`;
};
