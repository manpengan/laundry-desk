import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { fail } from "./hk-vps-release-core.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/u;
const POLICY_KEYS = Object.freeze(["heads", "postgres_major", "version"]);
const HEAD_KEYS = Object.freeze(["cluster_bootstrap_contract", "database_restored_catalog"]);
const PROOF_KEYS = Object.freeze(["entries", "sha256"]);
const CLUSTER_STATES = Object.freeze(["stable", "write_frozen"]);
const METADATA_KEYS = Object.freeze([
  "kind",
  "migration_head",
  "postgres_major",
  "primary_database",
]);
const CLUSTER_KINDS = new Set(["database", "database_acl", "role", "role_membership"]);

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertProof(value) {
  if (
    !exactKeys(value, PROOF_KEYS) ||
    !Number.isSafeInteger(value.entries) ||
    value.entries < 1 ||
    !DIGEST.test(value.sha256)
  ) {
    fail("CLOUD_RELEASE_CATALOG_POLICY_INVALID");
  }
}

function validatePolicy(value) {
  if (
    !exactKeys(value, POLICY_KEYS) ||
    value.version !== 1 ||
    value.postgres_major !== 16 ||
    typeof value.heads !== "object" ||
    value.heads === null ||
    Array.isArray(value.heads) ||
    Object.keys(value.heads).length < 1
  ) {
    fail("CLOUD_RELEASE_CATALOG_POLICY_INVALID");
  }
  for (const [head, contract] of Object.entries(value.heads)) {
    if (!MIGRATION.test(head) || !exactKeys(contract, HEAD_KEYS)) {
      fail("CLOUD_RELEASE_CATALOG_POLICY_INVALID");
    }
    assertProof(contract.database_restored_catalog);
    if (!exactKeys(contract.cluster_bootstrap_contract, CLUSTER_STATES)) {
      fail("CLOUD_RELEASE_CATALOG_POLICY_INVALID");
    }
    for (const state of CLUSTER_STATES) assertProof(contract.cluster_bootstrap_contract[state]);
  }
  return value;
}

function loadPolicy() {
  try {
    const source = readFileSync(new URL("./hk-vps-release-catalog-policy.json", import.meta.url), {
      encoding: "utf8",
      flag: "r",
    });
    return validatePolicy(JSON.parse(source));
  } catch (error) {
    if (error?.code === "CLOUD_RELEASE_CATALOG_POLICY_INVALID") throw error;
    fail("CLOUD_RELEASE_CATALOG_POLICY_INVALID", error);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJson(value[key])]),
  );
}

export function catalogProof(rows) {
  const canonical =
    rows
      .map((row) => JSON.stringify(stableJson(row)))
      .sort()
      .join("\n") + "\n";
  return Object.freeze({
    entries: rows.length,
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

function parseRows(source) {
  if (typeof source !== "string" || source.length < 2 || source.length > 4 * 1024 * 1024) {
    fail("CLOUD_RELEASE_CATALOG_INVALID");
  }
  try {
    const rows = source
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
      fail("CLOUD_RELEASE_CATALOG_INVALID");
    }
    return rows;
  } catch (error) {
    if (error?.code === "CLOUD_RELEASE_CATALOG_INVALID") throw error;
    fail("CLOUD_RELEASE_CATALOG_INVALID", error);
  }
}

function assertMetadata(value, policy) {
  if (
    !exactKeys(value, METADATA_KEYS) ||
    value.kind !== "catalog_contract" ||
    !MIGRATION.test(value.migration_head) ||
    !Number.isSafeInteger(value.postgres_major) ||
    typeof value.primary_database !== "boolean" ||
    value.postgres_major !== policy.postgres_major
  ) {
    fail("CLOUD_RELEASE_CATALOG_INVALID");
  }
  const contract = policy.heads[value.migration_head];
  if (contract === undefined) fail("CLOUD_RELEASE_CATALOG_HEAD_UNKNOWN");
  return contract;
}

function matches(actual, expected) {
  return actual.entries === expected.entries && actual.sha256 === expected.sha256;
}

export function parseCatalogPolicyEvidence(
  source,
  policy = CATALOG_GOLDEN_POLICY,
  clusterState = "write_frozen",
  requireCluster = undefined,
) {
  validatePolicy(policy);
  if (!CLUSTER_STATES.includes(clusterState)) fail("CLOUD_RELEASE_CATALOG_STATE_INVALID");
  if (requireCluster !== undefined && typeof requireCluster !== "boolean") {
    fail("CLOUD_RELEASE_CATALOG_STATE_INVALID");
  }
  const rows = parseRows(source);
  const metadataRows = rows.filter((row) => row.kind === "catalog_contract");
  if (metadataRows.length !== 1) fail("CLOUD_RELEASE_CATALOG_INVALID");
  const metadata = metadataRows[0];
  const contract = assertMetadata(metadata, policy);
  const catalogRows = rows.filter((row) => row !== metadata);
  const databaseRows = catalogRows.filter((row) => !CLUSTER_KINDS.has(row.kind));
  const clusterRows = catalogRows.filter((row) => CLUSTER_KINDS.has(row.kind));
  const databaseRestored = catalogProof(databaseRows);
  const clusterBootstrap = catalogProof(clusterRows);
  if (!matches(databaseRestored, contract.database_restored_catalog)) {
    fail("CLOUD_RELEASE_CATALOG_GOLDEN_MISMATCH");
  }
  const verifiesCluster = requireCluster ?? metadata.primary_database;
  if (
    verifiesCluster &&
    !matches(clusterBootstrap, contract.cluster_bootstrap_contract[clusterState])
  ) {
    fail("CLOUD_RELEASE_CATALOG_BOOTSTRAP_MISMATCH");
  }
  return Object.freeze({
    entries: databaseRestored.entries,
    sha256: databaseRestored.sha256,
    migrationHead: metadata.migration_head,
    postgresMajor: metadata.postgres_major,
    databaseRestored,
    clusterBootstrap: Object.freeze({
      ...clusterBootstrap,
      state: clusterState,
      verified: verifiesCluster,
    }),
  });
}

export const CATALOG_GOLDEN_POLICY = Object.freeze(loadPolicy());
