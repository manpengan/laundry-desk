import assert from "node:assert/strict";
import test from "node:test";

import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import { migrationExecutionRequest } from "./hk-vps-release-migration-client.mjs";
import { executeMigrationRequest } from "./hk-vps-release-migration-executor.mjs";
import { releasePaths } from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "c".repeat(32);
const ARCHIVE_DIGEST = "d".repeat(64);
const CONTROLLER_DIGEST = "e".repeat(64);
const MIGRATION_HEAD = "0046_print_job_request_idempotency.sql";
const TEMPORARY = `/var/lib/laundry-desk-release/.migration-${CANDIDATE}-test`;

function requestSource() {
  return JSON.stringify(
    migrationExecutionRequest(
      {
        archive_sha256: ARCHIVE_DIGEST,
        candidate_sha: CANDIDATE,
        controller_path: releaseControllerPath(CANDIDATE, TOKEN),
        controller_sha256: CONTROLLER_DIGEST,
        expected_sha: EXPECTED,
        migration_head: MIGRATION_HEAD,
        token: TOKEN,
      },
      {
        migrations: [{ checksum: "f".repeat(64), filename: MIGRATION_HEAD }],
        runner_sha256: "1".repeat(64),
        schema: "laundry.cloud-release.migration-authority",
        version: 1,
      },
    ),
  );
}

function dependencies(events, verify = async (root) => events.push(`verify:${root}`)) {
  return {
    chmod: async (path, mode) => events.push(`chmod:${path}:${mode.toString(8)}`),
    lstat: async () => ({
      gid: 0,
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o600,
      nlink: 1,
      size: 4096,
      uid: 0,
    }),
    mkdtemp: async () => TEMPORARY,
    realpath: async (path) => path,
    rm: async (path) => events.push(`rm:${path}`),
    runCloudCommand: async (file, arguments_, options) =>
      events.push({ arguments_, file, label: options.label }),
    sha256File: async () => ARCHIVE_DIGEST,
    syncDirectory: async (path) => events.push(`sync:${path}`),
    validateController: async () => ({
      digest: CONTROLLER_DIGEST,
      metadata: { archive_sha256: ARCHIVE_DIGEST },
    }),
    verifyMigrationAuthority: verify,
  };
}

test("verified controller executes only the root-private archive migration bundle", async () => {
  const events = [];
  await executeMigrationRequest(requestSource(), undefined, dependencies(events));
  const commands = events.filter((event) => typeof event === "object");
  assert.equal(commands[0].label, "CLOUD_RELEASE_MIGRATION_EXTRACT");
  assert.equal(commands[1].label, "CLOUD_RELEASE_MIGRATE");
  assert.equal(commands[1].file, "/usr/bin/bash");
  assert.equal(commands[1].arguments_.at(-1), TEMPORARY);
  assert.equal(
    commands.some(({ arguments_ }) =>
      arguments_.some((argument) =>
        argument.includes(`${releasePaths(CANDIDATE, EXPECTED).staging}/tools/compose`),
      ),
    ),
    false,
  );
  assert.deepEqual(
    events.filter((event) => typeof event === "string" && event.startsWith("verify:")),
    [`verify:${releasePaths(CANDIDATE, EXPECTED).staging}`, `verify:${TEMPORARY}`],
  );
  assert.equal(events.at(-1), `rm:${TEMPORARY}`);
});

test("staging authority mismatch prevents root migration and still removes the private bundle", async () => {
  const events = [];
  await assert.rejects(
    () =>
      executeMigrationRequest(
        requestSource(),
        undefined,
        dependencies(events, async (root) => {
          events.push(`verify:${root}`);
          throw Object.assign(new Error("tampered"), {
            code: "CLOUD_RELEASE_MIGRATION_AUTHORITY_MISMATCH",
          });
        }),
      ),
    { code: "CLOUD_RELEASE_MIGRATION_AUTHORITY_MISMATCH" },
  );
  assert.equal(
    events.some((event) => typeof event === "object" && event.label === "CLOUD_RELEASE_MIGRATE"),
    false,
  );
  assert.equal(events.at(-1), `rm:${TEMPORARY}`);
});
