import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ADR36_API_EVIDENCE_JOURNEYS,
  ADR36_API_EVIDENCE_SCHEMA,
  ADR36_API_EVIDENCE_VERSION,
  assertAdr36ApiAcceptancePassed,
  createAdr36ApiAcceptanceEvidence,
  parseAdr36ApiAcceptanceEvidence,
  requireAdr36ApiAcceptanceEvidence,
} from "./adr36-web-acceptance-evidence.mjs";
import { runAcceptance } from "./adr36-web-acceptance.mjs";
import {
  TEST_EXTENSIONS,
  acceptanceEnvironment,
  createFakeCloud,
  sequentialUuid,
} from "./adr36-web-acceptance.test-support.mjs";
import { REMINDER_FIXTURE_OPT_IN } from "./adr36-web-reminder-fixture.mjs";

const RUN_ID = "ADR36-20260810T123456Z-12345678";

function passedReport() {
  return Object.freeze({
    runId: RUN_ID,
    results: Object.freeze(
      ADR36_API_EVIDENCE_JOURNEYS.map((journey) => Object.freeze({ journey, status: "PASS" })),
    ),
    exitCode: 0,
  });
}

test("API evidence uses exact versioned keys and only canonical safe results", () => {
  const evidence = createAdr36ApiAcceptanceEvidence(passedReport());
  assert.deepEqual(Object.keys(evidence), ["schema", "version", "run_id", "results"]);
  assert.equal(evidence.schema, ADR36_API_EVIDENCE_SCHEMA);
  assert.equal(evidence.version, ADR36_API_EVIDENCE_VERSION);
  assert.equal(evidence.run_id, RUN_ID);
  assert.deepEqual(
    evidence.results.map((entry) => entry.journey),
    ADR36_API_EVIDENCE_JOURNEYS,
  );
  assert.deepEqual(assertAdr36ApiAcceptancePassed(evidence), evidence);
  assert.deepEqual(parseAdr36ApiAcceptanceEvidence(`${JSON.stringify(evidence)}\n`), evidence);
  assert.doesNotMatch(JSON.stringify(evidence), /password|cookie|token|phone|candidate/iu);
});

test("API evidence rejects schema drift, extra fields, reordered journeys and required failures", () => {
  const evidence = createAdr36ApiAcceptanceEvidence(passedReport());
  for (const invalid of [
    { ...evidence, schema: "wrong" },
    { ...evidence, version: 2 },
    { ...evidence, run_id: "ADR36-reused" },
    { ...evidence, candidate_sha: "a".repeat(40) },
    { ...evidence, results: [...evidence.results].reverse() },
  ]) {
    assert.throws(() => requireAdr36ApiAcceptanceEvidence(invalid));
  }
  const failed = createAdr36ApiAcceptanceEvidence({
    ...passedReport(),
    results: passedReport().results.map((entry) =>
      entry.journey === "reminder_history"
        ? { journey: entry.journey, status: "FAIL", code: "PRIVATE_REMOTE_DETAIL" }
        : entry,
    ),
  });
  assert.deepEqual(
    failed.results.find((entry) => entry.journey === "reminder_history"),
    {
      journey: "reminder_history",
      status: "FAIL",
      code: "ACCEPTANCE_FAILED",
    },
  );
  assert.throws(() => assertAdr36ApiAcceptancePassed(failed), {
    code: "ADR36_API_EVIDENCE_NOT_PASSED",
  });
  const contradictoryOverall = createAdr36ApiAcceptanceEvidence({
    ...passedReport(),
    results: passedReport().results.map((entry) =>
      entry.journey === "catalog_price"
        ? { journey: entry.journey, status: "FAIL", code: "ACCEPTANCE_FAILED" }
        : entry,
    ),
  });
  assert.equal(
    contradictoryOverall.results.find((entry) => entry.journey === "overall").status,
    "PASS",
  );
  assert.throws(() => assertAdr36ApiAcceptancePassed(contradictoryOverall), {
    code: "ADR36_API_EVIDENCE_NOT_PASSED",
  });
  assert.throws(() => parseAdr36ApiAcceptanceEvidence(`${JSON.stringify(evidence)}\nprivate`), {
    code: "ADR36_API_EVIDENCE_JSON_INVALID",
  });
});

test("API machine mode emits exactly one JSON line for a passing isolated journey", async () => {
  const env = Object.freeze({
    ...acceptanceEnvironment(),
    LAUNDRY_ADR36_REMINDER_FIXTURE: REMINDER_FIXTURE_OPT_IN,
  });
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: createFakeCloud(env).fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-10T12:34:56.000Z"),
    outputMode: "machine-json",
    writeLine: (line) => lines.push(line),
    createReminderFixture: async () => ({
      prepare: async () => Object.freeze({ safeProof: true }),
      verify: async () => {},
      cleanup: async () => true,
    }),
    reminderHistoryJourney: async () => Object.freeze({}),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(lines.length, 1);
  const evidence = assertAdr36ApiAcceptancePassed(parseAdr36ApiAcceptanceEvidence(lines[0]));
  assert.equal(evidence.run_id, report.runId);
  for (const secret of Object.values(env)) {
    assert.doesNotMatch(lines[0], new RegExp(secret, "u"));
  }
});

test("API machine subprocess emits one parseable failure object without contacting the network", () => {
  const entry = fileURLToPath(new URL("./adr36-web-acceptance.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [entry, "--machine-json"], {
    encoding: "utf8",
    env: Object.freeze({ PATH: process.env.PATH ?? "" }),
    timeout: 10_000,
  });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const evidence = parseAdr36ApiAcceptanceEvidence(child.stdout);
  assert.equal(evidence.results.find((entry_) => entry_.journey === "overall").status, "FAIL");
  assert.throws(() => assertAdr36ApiAcceptancePassed(evidence), {
    code: "ADR36_API_EVIDENCE_NOT_PASSED",
  });
});
