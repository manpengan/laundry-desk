import { createHash } from "node:crypto";

import { fail } from "./hk-vps-release-core.mjs";
import { parseCatalogPolicyEvidence } from "./hk-vps-release-catalog-policy.mjs";
import { assertMigrationLedger } from "./hk-vps-release-remote-migrations.mjs";

export const CATALOG_SQL = `WITH entries(value) AS (
  SELECT pg_catalog.jsonb_build_object('kind','catalog_contract',
    'migration_head',(SELECT filename FROM public.laundry_schema_migrations ORDER BY filename DESC LIMIT 1),
    'postgres_major',current_setting('server_version_num')::integer / 10000,
    'primary_database',current_database()='laundry_v2')
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','role','name',rolname,'can_login',rolcanlogin,
    'superuser',rolsuper,'create_database',rolcreatedb,'create_role',rolcreaterole,
    'inherit',rolinherit,'replication',rolreplication,'bypass_rls',rolbypassrls,
    'connection_limit',rolconnlimit) FROM pg_catalog.pg_roles
   WHERE rolname IN ('laundry_app','laundry_owner')
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','role_membership','role',role.rolname,
    'member',member.rolname,'grantor',pg_catalog.pg_get_userbyid(m.grantor),
    'admin_option',m.admin_option,'inherit_option',m.inherit_option,'set_option',m.set_option)
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles role ON role.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
   WHERE role.rolname IN ('laundry_app','laundry_owner')
      OR member.rolname IN ('laundry_app','laundry_owner')
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','database',
    'owner',pg_catalog.pg_get_userbyid(datdba),'allow_connections',datallowconn,
    'connection_limit',datconnlimit,'is_template',datistemplate) FROM pg_catalog.pg_database
   WHERE datname = current_database()
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','database_acl',
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(acl.grantor),'privilege',acl.privilege_type,
    'grantable',acl.is_grantable) FROM pg_catalog.pg_database d
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(d.datacl,
      pg_catalog.acldefault('d'::"char",d.datdba))) acl WHERE d.datname=current_database()
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','schema','name',nspname,
    'owner',pg_catalog.pg_get_userbyid(nspowner)) FROM pg_catalog.pg_namespace WHERE nspname='public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','schema_acl','schema',n.nspname,
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(acl.grantor),'privilege',acl.privilege_type,
    'grantable',acl.is_grantable) FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,
      pg_catalog.acldefault('n'::"char",n.nspowner))) acl WHERE n.nspname='public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','default_acl',
    'owner',pg_catalog.pg_get_userbyid(d.defaclrole),'schema',coalesce(n.nspname,''),
    'object_type',d.defaclobjtype,
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(acl.grantor),'privilege',acl.privilege_type,
    'grantable',acl.is_grantable) FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl
   WHERE d.defaclnamespace=0 OR n.nspname='public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','relation','schema',n.nspname,'name',c.relname,
    'relkind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
    'row_security',c.relrowsecurity,'force_row_security',c.relforcerowsecurity)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','policy','schema',n.nspname,'table',c.relname,
    'name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,
    'roles',ARRAY(SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid)
      END FROM unnest(p.polroles) AS roles(role_oid) ORDER BY 1),
    'using',coalesce(pg_catalog.pg_get_expr(p.polqual,p.polrelid,true),''),
    'check',coalesce(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,true),''))
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','table_acl','schema',n.nspname,'table',c.relname,
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(acl.grantor),'privilege',acl.privilege_type,
    'grantable',acl.is_grantable) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,
      pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::"char",c.relowner))) acl
   WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','column_acl','schema',n.nspname,'table',c.relname,
    'column',a.attname,'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(acl.grantor),'privilege',acl.privilege_type,
    'grantable',acl.is_grantable) FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
   WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','function','schema',n.nspname,'name',p.proname,
    'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'prokind',p.prokind,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
    'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,
    'config',ARRAY(SELECT setting FROM unnest(coalesce(p.proconfig,ARRAY[]::text[]))
      AS configs(setting) ORDER BY 1),'language',l.lanname,
    'definition',pg_catalog.pg_get_functiondef(p.oid)) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_object('kind','function_acl','schema',n.nspname,'name',p.proname,
    'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(acl.grantor),'privilege',acl.privilege_type,
    'grantable',acl.is_grantable) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,
      pg_catalog.acldefault('f'::"char",p.proowner))) acl WHERE n.nspname='public'
)
SELECT value::text FROM entries ORDER BY value::text`;

const MANIFEST_KEYS = Object.freeze([
  "backup_sha256",
  "bytes",
  "candidate_sha",
  "created_at",
  "expected_sha",
  "pre_migration_count",
  "pre_migration_head",
  "pre_migration_ledger_sha256",
  "scope",
  "shadow_catalog_entries",
  "shadow_catalog_sha256",
  "shadow_database",
  "shadow_restore",
  "source_catalog_entries",
  "source_catalog_sha256",
  "version",
]);

export const parseCatalogEvidence = parseCatalogPolicyEvidence;

export function migrationLedgerDigest(ledger) {
  assertMigrationLedger(ledger, ledger, "exact");
  const canonical = ledger.map((row) => `${row.filename}\t${row.checksum}\n`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createBackupManifest(context, evidence, artifact, shadowCatalog, createdAt) {
  return Object.freeze({
    backup_sha256: artifact.sha256,
    bytes: artifact.bytes,
    candidate_sha: context.candidateSha,
    created_at: createdAt,
    expected_sha: context.expectedSha,
    pre_migration_count: evidence.ledger.length,
    pre_migration_head: evidence.ledger.at(-1)?.filename,
    pre_migration_ledger_sha256: migrationLedgerDigest(evidence.ledger),
    scope: "database_only_same_postgresql_cluster",
    shadow_catalog_entries: shadowCatalog?.entries ?? null,
    shadow_catalog_sha256: shadowCatalog?.sha256 ?? null,
    shadow_database: artifact.shadow,
    shadow_restore: shadowCatalog === null ? "pending" : "verified",
    source_catalog_entries: evidence.catalog.entries,
    source_catalog_sha256: evidence.catalog.sha256,
    version: 2,
  });
}

export function assertBackupManifest(manifest, record, bytes) {
  const keys =
    typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? Object.keys(manifest).sort()
      : [];
  if (
    keys.length !== MANIFEST_KEYS.length ||
    keys.some((key, index) => key !== MANIFEST_KEYS[index]) ||
    manifest.version !== 2 ||
    manifest.backup_sha256 !== record.backup_sha256 ||
    manifest.bytes !== bytes ||
    manifest.candidate_sha !== record.candidate_sha ||
    manifest.expected_sha !== record.expected_sha ||
    manifest.pre_migration_count !== record.pre_migration_count ||
    manifest.pre_migration_head !== record.pre_migration_head ||
    manifest.pre_migration_ledger_sha256 !== record.pre_migration_ledger_sha256 ||
    manifest.source_catalog_sha256 !== record.source_catalog_sha256 ||
    manifest.shadow_catalog_sha256 !== record.source_catalog_sha256 ||
    manifest.shadow_database !== record.shadow_database ||
    !Number.isSafeInteger(manifest.source_catalog_entries) ||
    manifest.source_catalog_entries < 1 ||
    manifest.shadow_catalog_entries !== manifest.source_catalog_entries ||
    manifest.scope !== "database_only_same_postgresql_cluster" ||
    manifest.shadow_restore !== "verified" ||
    typeof manifest.created_at !== "string" ||
    Number.isNaN(Date.parse(manifest.created_at))
  ) {
    fail("CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID");
  }
}
