export {
  TENANT_TABLE_MATRIX,
  getTenantTableDescriptor,
  getTenantTableScope,
  isTenantTableDescriptor,
} from "./table-matrix.js";
export type {
  GlobalScopeTableName,
  OrgScopeTableName,
  StoreScopeTableName,
  TenantTableDescriptor,
  TenantTableScope,
  V2TableName,
} from "./table-matrix.js";

export {
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
} from "./keys.js";
export type { TenantForeignKeyDescriptor, TenantUniqueKeyDescriptor } from "./keys.js";

export {
  ORG_TENANT_PREDICATE_SQL,
  STORE_TENANT_PREDICATE_SQL,
  buildMaintenancePolicySql,
  buildOrgTenantPolicySql,
  buildStoreTenantPolicySql,
} from "./rls-templates.js";
export type { MaintenancePolicySqlInput, TenantPolicySqlInput } from "./rls-templates.js";
