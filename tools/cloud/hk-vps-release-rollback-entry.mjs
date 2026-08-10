import { fail, requireMigrationHead, requireSha, requireToken } from "./hk-vps-release-core.mjs";
import { rollbackRelease } from "./hk-vps-release-remote-rollback.mjs";

const KEYS = Object.freeze([
  "candidate_sha",
  "expected_sha",
  "migration_head",
  "schema",
  "token",
  "version",
]);

function parseRequest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CLOUD_RELEASE_ROLLBACK_REQUEST_INVALID");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== KEYS.length ||
    keys.some((key, index) => key !== KEYS[index]) ||
    value.schema !== "laundry.cloud-release.rollback-request" ||
    value.version !== 1
  ) {
    fail("CLOUD_RELEASE_ROLLBACK_REQUEST_INVALID");
  }
  return Object.freeze({
    candidateSha: requireSha(value.candidate_sha),
    expectedSha: requireSha(value.expected_sha),
    migrationHead: requireMigrationHead(value.migration_head),
    token: requireToken(value.token),
  });
}

export async function runRollbackRequest(request, dependencies = {}) {
  return await (dependencies.rollbackRelease ?? rollbackRelease)(parseRequest(request));
}
