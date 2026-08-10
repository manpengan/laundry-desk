import assert from "node:assert/strict";
import test from "node:test";

import { catalogProof } from "./hk-vps-release-catalog-policy.mjs";
import {
  CATALOG_SQL,
  assertBackupManifest,
  createBackupManifest,
  migrationLedgerDigest,
  parseCatalogEvidence,
} from "./hk-vps-release-remote-db-evidence.mjs";

const HEAD = "0046_print_job_request_idempotency.sql";
const DIGEST_1 = "1".repeat(64);
const DIGEST_2 = "2".repeat(64);
const CLUSTER_KINDS = new Set(["database", "database_acl", "role", "role_membership"]);
const LEDGER = Object.freeze([
  Object.freeze({ filename: "0045_cloud_auth.sql", checksum: DIGEST_1 }),
  Object.freeze({ filename: "0046_cloud_primary.sql", checksum: DIGEST_2 }),
]);

function catalogRows({ appCanLogin = false, head = HEAD, primaryDatabase = true } = {}) {
  return [
    {
      kind: "catalog_contract",
      migration_head: head,
      postgres_major: 16,
      primary_database: primaryDatabase,
    },
    {
      kind: "role",
      name: "laundry_owner",
      can_login: false,
      superuser: false,
      create_database: false,
      create_role: false,
      inherit: false,
      replication: false,
      bypass_rls: false,
      connection_limit: -1,
    },
    {
      kind: "role",
      name: "laundry_app",
      can_login: appCanLogin,
      superuser: false,
      create_database: false,
      create_role: false,
      inherit: false,
      replication: false,
      bypass_rls: false,
      connection_limit: -1,
    },
    {
      kind: "database",
      owner: "laundry_owner",
      allow_connections: true,
      connection_limit: -1,
      is_template: false,
    },
    {
      kind: "database_acl",
      grantee: "laundry_app",
      grantor: "laundry_owner",
      privilege: "CONNECT",
      grantable: false,
    },
    { kind: "schema", name: "public", owner: "pg_database_owner" },
    {
      kind: "schema_acl",
      schema: "public",
      grantee: "laundry_app",
      grantor: "laundry_owner",
      privilege: "USAGE",
      grantable: false,
    },
    {
      kind: "default_acl",
      owner: "laundry_owner",
      schema: "public",
      object_type: "r",
      grantee: "laundry_app",
      grantor: "laundry_owner",
      privilege: "SELECT",
      grantable: false,
    },
    {
      kind: "relation",
      schema: "public",
      name: "orders",
      relkind: "r",
      owner: "laundry_owner",
      row_security: true,
      force_row_security: true,
    },
    {
      kind: "policy",
      schema: "public",
      table: "orders",
      name: "orders_org_scope",
      permissive: true,
      command: "*",
      roles: ["laundry_app"],
      using: "(org_id = current_setting('app.org_id')::uuid)",
      check: "(org_id = current_setting('app.org_id')::uuid)",
    },
    {
      kind: "table_acl",
      schema: "public",
      table: "orders",
      grantee: "laundry_app",
      grantor: "laundry_owner",
      privilege: "SELECT",
      grantable: false,
    },
    {
      kind: "column_acl",
      schema: "public",
      table: "orders",
      column: "updated_at",
      grantee: "laundry_app",
      grantor: "laundry_owner",
      privilege: "UPDATE",
      grantable: false,
    },
    {
      kind: "function",
      schema: "public",
      name: "laundry_auth_lookup_session",
      arguments: "uuid",
      prokind: "f",
      owner: "laundry_owner",
      security_definer: true,
      leakproof: false,
      volatility: "s",
      parallel: "u",
      config: ["search_path=pg_catalog, pg_temp"],
      language: "sql",
      definition: "CREATE FUNCTION laundry_auth_lookup_session(uuid) RETURNS uuid ...",
    },
    {
      kind: "function_acl",
      schema: "public",
      name: "laundry_auth_lookup_session",
      arguments: "uuid",
      grantee: "laundry_app",
      grantor: "laundry_owner",
      privilege: "EXECUTE",
      grantable: false,
    },
  ];
}

function splitProof(rows) {
  const catalog = rows.filter((row) => row.kind !== "catalog_contract");
  return {
    database: catalogProof(catalog.filter((row) => !CLUSTER_KINDS.has(row.kind))),
    cluster: catalogProof(catalog.filter((row) => CLUSTER_KINDS.has(row.kind))),
  };
}

function catalogPolicy() {
  const frozen = splitProof(catalogRows());
  const stable = splitProof(catalogRows({ appCanLogin: true }));
  return {
    version: 1,
    postgres_major: 16,
    heads: {
      [HEAD]: {
        database_restored_catalog: frozen.database,
        cluster_bootstrap_contract: {
          stable: stable.cluster,
          write_frozen: frozen.cluster,
        },
      },
    },
  };
}

function catalogSource(rows = catalogRows()) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function parse(rows = catalogRows(), clusterState = "write_frozen", requireCluster) {
  return parseCatalogEvidence(catalogSource(rows), catalogPolicy(), clusterState, requireCluster);
}

test("catalog query separates restored surfaces from PostgreSQL 16 cluster bootstrap state", () => {
  for (const fragment of [
    "laundry_schema_migrations",
    "server_version_num",
    "pg_auth_members",
    "datacl",
    "relowner",
    "relrowsecurity",
    "relforcerowsecurity",
    "pg_policy",
    "pg_default_acl",
    "attacl",
    "pg_get_function_identity_arguments",
    "pg_get_functiondef",
    "prosecdef",
    "proconfig",
    "rolcanlogin",
  ]) {
    assert.ok(CATALOG_SQL.includes(fragment), fragment);
  }
});

test("head-bound catalog proof is order independent and distinguishes stable from frozen roles", () => {
  const frozenRows = catalogRows();
  const frozen = parse(frozenRows);
  assert.deepEqual(parse([...frozenRows].reverse()), frozen);
  assert.equal(frozen.clusterBootstrap.state, "write_frozen");
  assert.equal(frozen.clusterBootstrap.verified, true);

  const stable = parse(catalogRows({ appCanLogin: true }), "stable");
  assert.equal(stable.sha256, frozen.sha256);
  assert.notEqual(stable.clusterBootstrap.sha256, frozen.clusterBootstrap.sha256);
  assert.throws(() => parse(catalogRows({ appCanLogin: true })), {
    code: "CLOUD_RELEASE_CATALOG_BOOTSTRAP_MISMATCH",
  });
});

test("golden policy rejects every protected catalog surface mutation", () => {
  const rows = catalogRows();
  const mutations = [
    ["relation", { row_security: false }],
    ["relation", { force_row_security: false }],
    ["relation", { owner: "postgres" }],
    ["policy", { using: "true" }],
    ["policy", { roles: ["PUBLIC"] }],
    ["schema_acl", { grantee: "PUBLIC", privilege: "CREATE" }],
    ["default_acl", { grantable: true }],
    ["table_acl", { grantee: "PUBLIC", privilege: "UPDATE" }],
    ["column_acl", { grantable: true }],
    ["function", { config: ["search_path=public"] }],
    ["function", { definition: "CREATE FUNCTION compromised() RETURNS void ..." }],
    ["function", { owner: "postgres" }],
    ["function_acl", { grantee: "PUBLIC", privilege: "EXECUTE" }],
    ["function_acl", { grantable: true }],
    ["database", { owner: "postgres" }],
    ["role", { superuser: true }],
  ];
  for (const [kind, patch] of mutations) {
    const changed = rows.map((row) => (row.kind === kind ? { ...row, ...patch } : row));
    assert.throws(() => parse(changed), {
      code: CLUSTER_KINDS.has(kind)
        ? "CLOUD_RELEASE_CATALOG_BOOTSTRAP_MISMATCH"
        : "CLOUD_RELEASE_CATALOG_GOLDEN_MISMATCH",
    });
  }
});

test("golden policy rejects missing, extra, unknown-head, and wrong-major evidence", () => {
  const rows = catalogRows();
  for (const invalid of [
    rows.filter((row) => row.kind !== "policy"),
    [...rows, { kind: "relation", schema: "public", name: "surprise" }],
  ]) {
    assert.throws(() => parse(invalid), { code: "CLOUD_RELEASE_CATALOG_GOLDEN_MISMATCH" });
  }
  assert.throws(() => parse(catalogRows({ head: "0047_unknown.sql" })), {
    code: "CLOUD_RELEASE_CATALOG_HEAD_UNKNOWN",
  });
  const wrongMajor = rows.map((row) =>
    row.kind === "catalog_contract" ? { ...row, postgres_major: 17 } : row,
  );
  assert.throws(() => parse(wrongMajor), { code: "CLOUD_RELEASE_CATALOG_INVALID" });
});

test("shadow restore validates only database-restored rows, never same-cluster role or datacl state", () => {
  const shadow = catalogRows({ primaryDatabase: false }).map((row) =>
    row.kind === "role" ? { ...row, can_login: true } : row,
  );
  const evidence = parse(shadow);
  assert.equal(evidence.clusterBootstrap.verified, false);
  const changedRelation = shadow.map((row) =>
    row.kind === "relation" ? { ...row, owner: "postgres" } : row,
  );
  assert.throws(() => parse(changedRelation), {
    code: "CLOUD_RELEASE_CATALOG_GOLDEN_MISMATCH",
  });
});

test("migration ledger digest covers the complete ordered ledger", () => {
  const baseline = migrationLedgerDigest(LEDGER);
  const changed = [{ ...LEDGER[0], checksum: "3".repeat(64) }, LEDGER[1]];
  assert.match(baseline, /^[0-9a-f]{64}$/u);
  assert.notEqual(migrationLedgerDigest(changed), baseline);
  assert.notEqual(migrationLedgerDigest([...LEDGER].reverse()), baseline);
});

test("manifest records pending locator before drill and only verifies restored catalog proofs", () => {
  const catalog = parse();
  const context = { candidateSha: "a".repeat(40), expectedSha: "b".repeat(40) };
  const evidence = { catalog, ledger: LEDGER };
  const artifact = {
    bytes: 2048,
    sha256: "c".repeat(64),
    shadow: `laundry_release_verify_${"d".repeat(32)}`,
  };
  const createdAt = "2026-08-10T01:02:03.000Z";
  const pending = createBackupManifest(context, evidence, artifact, null, createdAt);
  const verified = createBackupManifest(context, evidence, artifact, catalog, createdAt);
  assert.equal(pending.shadow_restore, "pending");
  assert.equal(pending.shadow_catalog_sha256, null);
  assert.equal(verified.shadow_restore, "verified");
  assert.equal(verified.pre_migration_ledger_sha256, migrationLedgerDigest(LEDGER));
  const record = {
    backup_sha256: artifact.sha256,
    candidate_sha: context.candidateSha,
    expected_sha: context.expectedSha,
    pre_migration_count: LEDGER.length,
    pre_migration_head: LEDGER.at(-1).filename,
    pre_migration_ledger_sha256: migrationLedgerDigest(LEDGER),
    shadow_database: artifact.shadow,
    source_catalog_sha256: catalog.sha256,
  };
  assert.doesNotThrow(() => assertBackupManifest(verified, record, artifact.bytes));
  for (const invalid of [
    { ...verified, shadow_catalog_sha256: "e".repeat(64) },
    { ...verified, surprise: true },
    { ...verified, shadow_restore: "pending" },
  ]) {
    assert.throws(() => assertBackupManifest(invalid, record, artifact.bytes), {
      code: "CLOUD_RELEASE_BACKUP_EVIDENCE_INVALID",
    });
  }
});
