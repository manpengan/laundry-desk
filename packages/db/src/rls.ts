import {
  buildMaintenancePolicySql,
  buildOrgTenantPolicySql,
  buildStoreTenantPolicySql,
  getTenantTableDescriptor,
  type OrgScopeTableName,
  type StoreScopeTableName,
} from "@laundry/contracts";

import { LAUNDRY_APP_ROLE, LAUNDRY_OWNER_ROLE, PUBLIC_SCHEMA } from "./roles.js";

/** M1 org-scope tables that receive A3 org tenant RLS. */
export const M1_ORG_RLS_TABLES = Object.freeze([
  "stores",
  "staffs",
  "settings",
] as const satisfies readonly OrgScopeTableName[]);

/** M1 store-scope matrix tables that receive A3 store tenant RLS. */
export const M1_STORE_RLS_TABLES = Object.freeze([
  "staff_store_roles",
  "store_features",
  "audit_log",
] as const satisfies readonly StoreScopeTableName[]);

/**
 * Session infrastructure tables (A5) use the same store-scope predicate as matrix store tables.
 * They are not in TENANT_TABLE_MATRIX; SQL is inlined to avoid inventing matrix entries.
 */
export const M1_SESSION_RLS_TABLES = Object.freeze([
  "sessions",
  "refresh_families",
  "refresh_tokens",
  "pin_challenges",
  "pin_lockouts",
] as const);

const STORE_PREDICATE = `org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid`;

const quoteIdent = (identifier: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) {
    throw new TypeError(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const buildSessionStorePolicySql = (table: string): string => {
  const qualified = `${quoteIdent(PUBLIC_SCHEMA)}.${quoteIdent(table)}`;
  const policy = quoteIdent(`${table}_store_scope`);
  const role = quoteIdent(LAUNDRY_APP_ROLE);
  return `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${policy} ON ${qualified}
  AS PERMISSIVE
  FOR ALL
  TO ${role}
  USING (${STORE_PREDICATE})
  WITH CHECK (${STORE_PREDICATE});`;
};

const buildSessionMaintenancePolicySql = (table: string): string => {
  const qualified = `${quoteIdent(PUBLIC_SCHEMA)}.${quoteIdent(table)}`;
  const policy = quoteIdent(`${table}_maintenance`);
  const role = quoteIdent(LAUNDRY_OWNER_ROLE);
  return `CREATE POLICY ${policy} ON ${qualified}
  AS PERMISSIVE
  FOR ALL
  TO ${role}
  USING (true)
  WITH CHECK (true);`;
};

/** Render A3 tenant + maintenance policies for all M1 RLS targets. */
export const buildM1RlsMigrationSql = (): string => {
  const sections: string[] = [
    "-- M1 RLS policies generated from @laundry/contracts A3 templates",
    "-- Global table orgs: no tenant GUC policy (matrix scope = global).",
  ];

  for (const table of M1_ORG_RLS_TABLES) {
    const descriptor = getTenantTableDescriptor(table);
    if (descriptor.scope !== "org") {
      throw new TypeError(`Expected org scope for ${table}`);
    }
    sections.push(
      buildOrgTenantPolicySql({
        schema: PUBLIC_SCHEMA,
        table,
        policy: `${table}_org_scope`,
        role: LAUNDRY_APP_ROLE,
      }),
    );
    sections.push(
      buildMaintenancePolicySql({
        schema: PUBLIC_SCHEMA,
        table,
        policy: `${table}_maintenance`,
        maintenanceRole: LAUNDRY_OWNER_ROLE,
      }),
    );
  }

  for (const table of M1_STORE_RLS_TABLES) {
    const descriptor = getTenantTableDescriptor(table);
    if (descriptor.scope !== "store") {
      throw new TypeError(`Expected store scope for ${table}`);
    }
    sections.push(
      buildStoreTenantPolicySql({
        schema: PUBLIC_SCHEMA,
        table,
        policy: `${table}_store_scope`,
        role: LAUNDRY_APP_ROLE,
      }),
    );
    sections.push(
      buildMaintenancePolicySql({
        schema: PUBLIC_SCHEMA,
        table,
        policy: `${table}_maintenance`,
        maintenanceRole: LAUNDRY_OWNER_ROLE,
      }),
    );
  }

  for (const table of M1_SESSION_RLS_TABLES) {
    sections.push(buildSessionStorePolicySql(table));
    sections.push(buildSessionMaintenancePolicySql(table));
  }

  return `${sections.join("\n\n")}\n`;
};
