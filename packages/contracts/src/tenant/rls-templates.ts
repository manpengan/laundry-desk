import {
  getTenantTableDescriptor,
  type OrgScopeTableName,
  type StoreScopeTableName,
  type V2TableName,
} from "./table-matrix.js";
import { capturePrimitiveStringProperties } from "./input-snapshot.js";

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

export type MaintenancePolicySqlInput = Readonly<{
  schema: string;
  table: OrgScopeTableName | StoreScopeTableName;
  policy: string;
  maintenanceRole: string;
}>;

const TENANT_POLICY_INPUT_KEYS = ["schema", "table", "policy", "role"] as const;
const MAINTENANCE_POLICY_INPUT_KEYS = ["schema", "table", "policy", "maintenanceRole"] as const;

const quoteIdentifier = (identifier: unknown, label: string): string => {
  if (typeof identifier !== "string" || !SQL_IDENTIFIER.test(identifier)) {
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

const requireMaintenanceTenantTable = (table: string): void => {
  const descriptor = getTenantTableDescriptor(table);
  if (descriptor.scope === "global") {
    throw new TypeError(`Maintenance policy cannot target global-scope table "${table}"`);
  }
};

const buildTenantPolicySql = (
  input: TenantPolicySqlInput,
  predicate: string,
  expectedScope: "org" | "store",
): string => {
  const captured = capturePrimitiveStringProperties(
    input,
    TENANT_POLICY_INPUT_KEYS,
    "Tenant policy input",
  );
  const table = qualifiedTable(captured.schema, captured.table);
  const policy = quoteIdentifier(captured.policy, "policy");
  const role = quoteIdentifier(captured.role, "role");
  requireTenantTableScope(captured.table, expectedScope);

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
  const captured = capturePrimitiveStringProperties(
    input,
    MAINTENANCE_POLICY_INPUT_KEYS,
    "Maintenance policy input",
  );
  const table = qualifiedTable(captured.schema, captured.table);
  const policy = quoteIdentifier(captured.policy, "policy");
  const maintenanceRole = quoteIdentifier(captured.maintenanceRole, "maintenance role");
  requireMaintenanceTenantTable(captured.table);
  if (captured.maintenanceRole !== "laundry_owner") {
    throw new TypeError("Maintenance policy role must be laundry_owner");
  }

  return `CREATE POLICY ${policy} ON ${table}
  AS PERMISSIVE
  FOR ALL
  TO ${maintenanceRole}
  USING (true)
  WITH CHECK (true);`;
};
