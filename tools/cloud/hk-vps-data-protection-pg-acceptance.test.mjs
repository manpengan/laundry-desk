import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dataProtectionPgFailureMarker,
  runDataProtectionPgAcceptance,
} from "./hk-vps-data-protection-pg-acceptance.mjs";
import {
  createDataProtectionPgAdapter,
  discoverDataProtectionPostgresContainer,
} from "./hk-vps-data-protection-pg-adapter.mjs";

test("real data protection acceptance requires every isolated PostgreSQL opt-in", async () => {
  let configReads = 0;
  await assert.rejects(
    () =>
      runDataProtectionPgAcceptance({
        environment: {
          LAUNDRY_CLOUD_DATA_PG_TEST: "1",
          LAUNDRY_USE_LOCAL_PG: "1",
          COMPOSE_PROJECT_NAME: "laundry-commission-pg-test",
        },
        ensureConfig: async () => {
          configReads += 1;
        },
      }),
    { code: "CLOUD_DATA_PG_OPT_IN_REQUIRED" },
  );
  assert.equal(configReads, 0);
});

test("real data protection acceptance reports only a bounded failure code", () => {
  assert.equal(
    dataProtectionPgFailureMarker({
      code: "CLOUD_DATA_PG_ACCEPTANCE_RECOVERY_FAILED",
      cause: { code: "CLOUD_DATA_PG_RESTORE_FAILED", cause: { code: "secret=not-for-output" } },
    }),
    "CLOUD_DATA_PG_ACCEPTANCE_FAILED code=CLOUD_DATA_PG_ACCEPTANCE_RECOVERY_FAILED,CLOUD_DATA_PG_RESTORE_FAILED",
  );
  assert.equal(
    dataProtectionPgFailureMarker({ code: "secret=not-for-output" }),
    "CLOUD_DATA_PG_ACCEPTANCE_FAILED code=UNKNOWN",
  );
});

test("the recovery acceptance binds its simulated code switch to the candidate marker", async () => {
  const source = await readFile(
    new URL("./hk-vps-data-protection-pg-acceptance.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /readMarker:\s*async \(\) => \(\{ git_sha: codeSha \}\)/u);
});

test("PostgreSQL container discovery accepts one exact compose container id", async () => {
  const container = "a".repeat(64);
  assert.equal(
    await discoverDataProtectionPostgresContainer({
      project: "laundry-commission-pg-test",
      cwd: "/repo",
      environment: {},
      runDocker: async () => ({ stdout: `${container}\n`, stderr: "" }),
    }),
    container,
  );
  await assert.rejects(
    () =>
      discoverDataProtectionPostgresContainer({
        project: "laundry-commission-pg-test",
        cwd: "/repo",
        environment: {},
        runDocker: async () => ({ stdout: "container-name\n", stderr: "" }),
      }),
    { code: "CLOUD_DATA_PG_CONTAINER_INVALID" },
  );
});

test("real restore adapter uses fixed Docker pg_restore arguments without credentials", async () => {
  const calls = [];
  const adapter = createDataProtectionPgAdapter({
    container: "b".repeat(64),
    password: "not-printed-test-password",
    cwd: "/repo",
    environment: {},
    runDocker: async (arguments_) => {
      calls.push(arguments_);
      return { stdout: "", stderr: "" };
    },
  });
  await adapter.restore("/private/database.dump", "laundry_v2", true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 2), ["cp", "/private/database.dump"]);
  assert.deepEqual(calls[1].slice(0, 6), [
    "exec",
    "b".repeat(64),
    "pg_restore",
    "-U",
    "postgres",
    "--clean",
  ]);
  assert.ok(calls[1].includes("--if-exists"));
  assert.ok(calls[1].includes("--single-transaction"));
  assert.equal(JSON.stringify(calls).includes("not-printed-test-password"), false);
  assert.deepEqual(calls[2].slice(0, 4), ["exec", "b".repeat(64), "rm", "-f"]);
});
