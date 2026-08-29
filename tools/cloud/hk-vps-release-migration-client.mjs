import { join } from "node:path";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import {
  fail,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
} from "./hk-vps-release-core.mjs";
import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import { parseMigrationAuthority } from "./hk-vps-release-migration-authority.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";

const MIGRATION_EXECUTOR_RELATIVE = "tools/cloud/hk-vps-release-migration-executor.mjs";
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

export function migrationExecutionRequest(record, inputAuthority) {
  const candidate = requireSha(record.candidate_sha);
  const expected = requireSha(record.expected_sha);
  const token = requireToken(record.token);
  const migrationHead = requireMigrationHead(record.migration_head);
  const controllerPath = releaseControllerPath(candidate, token);
  if (record.controller_path !== controllerPath) fail("CLOUD_RELEASE_CONTROLLER_BINDING_INVALID");
  const authority = parseMigrationAuthority(inputAuthority);
  if (authority.migrations.at(-1)?.filename !== migrationHead) {
    fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
  }
  return Object.freeze({
    archive_sha256: requireDigest(record.archive_sha256),
    authority,
    candidate_sha: candidate,
    controller_sha256: requireDigest(record.controller_sha256),
    expected_sha: expected,
    migration_head: migrationHead,
    schema: "laundry.cloud-release.migration-request",
    token,
    version: 1,
  });
}

export async function applyMigrations(record, authority, signal, dependencies = {}) {
  const request = migrationExecutionRequest(record, authority);
  await (dependencies.runCloudCommand ?? runCloudCommand)(
    PROFILE.paths.nodeExecutable,
    [join(record.controller_path, MIGRATION_EXECUTOR_RELATIVE)],
    Object.freeze({
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      input: JSON.stringify(request),
      label: "CLOUD_RELEASE_MIGRATE",
      signal,
      timeoutMs: 10 * 60_000,
    }),
  );
}
