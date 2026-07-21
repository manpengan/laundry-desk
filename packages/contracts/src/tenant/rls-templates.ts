const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export const ORG_TENANT_PREDICATE_SQL =
  "org_id = NULLIF(current_setting('app.org_id', true), '')::uuid";
export const STORE_TENANT_PREDICATE_SQL = `${ORG_TENANT_PREDICATE_SQL}
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid`;

type TenantPolicySqlInput = Readonly<{
  schema: string;
  table: string;
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

const buildTenantPolicySql = (input: TenantPolicySqlInput, predicate: string): string => {
  const table = qualifiedTable(input.schema, input.table);
  const policy = quoteIdentifier(input.policy, "policy");
  const role = quoteIdentifier(input.role, "role");

  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${policy} ON ${table}
  AS PERMISSIVE
  FOR ALL
  TO ${role}
  USING (${predicate})
  WITH CHECK (${predicate});`;
};

export const buildOrgTenantPolicySql = (input: TenantPolicySqlInput): string =>
  buildTenantPolicySql(input, ORG_TENANT_PREDICATE_SQL);

export const buildStoreTenantPolicySql = (input: TenantPolicySqlInput): string =>
  buildTenantPolicySql(input, STORE_TENANT_PREDICATE_SQL);

export const buildMaintenancePolicySql = (input: MaintenancePolicySqlInput): string => {
  const table = qualifiedTable(input.schema, input.table);
  const policy = quoteIdentifier(input.policy, "policy");
  const maintenanceRole = quoteIdentifier(input.maintenanceRole, "maintenance role");
  if (input.maintenanceRole === "laundry_app") {
    throw new TypeError("Maintenance policy cannot target the application role laundry_app");
  }

  return `CREATE POLICY ${policy} ON ${table}
  AS PERMISSIVE
  FOR ALL
  TO ${maintenanceRole}
  USING (true)
  WITH CHECK (true);`;
};
