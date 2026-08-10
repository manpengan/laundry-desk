import assert from "node:assert/strict";
import test from "node:test";

import CloudEvidenceReporter from "../../apps/web/e2e-cloud/cloud-evidence-reporter.mjs";
import {
  CLOUD_BROWSER_EVIDENCE_ATTACHMENT,
  CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE,
  CLOUD_BROWSER_EVIDENCE_SCHEMA,
  CLOUD_BROWSER_EVIDENCE_VERSION,
  CLOUD_BROWSER_EXPECTED_TEST_TITLE,
  assertCloudBrowserEvidencePassed,
  createCloudBrowserEvidence,
  parseCloudBrowserEvidence,
  requireCloudBrowserEvidence,
} from "./cloud-web-browser-evidence.mjs";

const RUN_ID = "CLOUD-BROWSER-20260810T123456Z-12345678";

function passedResults() {
  return Object.freeze([
    Object.freeze({ journey: "configuration", status: "PASS" }),
    Object.freeze({ journey: "core_ui_subset", status: "PASS" }),
    Object.freeze({ journey: "session_logout", status: "PASS" }),
    Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
    Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
  ]);
}

function passedEvidence(overrides = {}) {
  return createCloudBrowserEvidence({
    runId: RUN_ID,
    testCount: 1,
    testTitle: CLOUD_BROWSER_EXPECTED_TEST_TITLE,
    testStatus: "PASS",
    retries: 0,
    results: passedResults(),
    ...overrides,
  });
}

function reporterConfig() {
  return Object.freeze({
    metadata: Object.freeze({ cloudBrowserRunId: RUN_ID }),
    projects: Object.freeze([Object.freeze({ retries: 0 })]),
    workers: 1,
  });
}

function expectedTest() {
  return Object.freeze({ title: CLOUD_BROWSER_EXPECTED_TEST_TITLE, expectedStatus: "passed" });
}

function evidenceAttachment(evidence = passedEvidence()) {
  return Object.freeze({
    name: CLOUD_BROWSER_EVIDENCE_ATTACHMENT,
    contentType: CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE,
    body: Buffer.from(JSON.stringify(evidence), "utf8"),
  });
}

test("browser evidence has exact safe keys and requires the complete read-only proof", () => {
  const evidence = passedEvidence();
  assert.deepEqual(Object.keys(evidence), [
    "schema",
    "version",
    "run_id",
    "test_count",
    "test_title",
    "test_status",
    "retries",
    "results",
  ]);
  assert.equal(evidence.schema, CLOUD_BROWSER_EVIDENCE_SCHEMA);
  assert.equal(evidence.version, CLOUD_BROWSER_EVIDENCE_VERSION);
  assert.deepEqual(assertCloudBrowserEvidencePassed(evidence), evidence);
  assert.deepEqual(parseCloudBrowserEvidence(`${JSON.stringify(evidence)}\n`), evidence);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /password|cookie|token|trace|screenshot|candidate|phone/iu,
  );
});

test("browser evidence rejects schema drift, extra fields, skips, retries and status gaps", () => {
  const evidence = passedEvidence();
  for (const invalid of [
    { ...evidence, schema: "wrong" },
    { ...evidence, version: 2 },
    { ...evidence, run_id: "CLOUD-BROWSER-reused" },
    { ...evidence, cookie: "private" },
    { ...evidence, results: [...evidence.results].reverse() },
  ]) {
    assert.throws(() => requireCloudBrowserEvidence(invalid));
  }
  for (const incomplete of [
    passedEvidence({ testCount: 2 }),
    passedEvidence({ testStatus: "SKIPPED" }),
    passedEvidence({ retries: 1 }),
    passedEvidence({
      results: passedResults().map((entry) =>
        entry.journey === "session_logout" ? { ...entry, status: "FAIL" } : entry,
      ),
    }),
  ]) {
    assert.throws(() => assertCloudBrowserEvidencePassed(incomplete), {
      code: "CLOUD_BROWSER_EVIDENCE_NOT_PASSED",
    });
  }
  assert.throws(() => parseCloudBrowserEvidence(`${JSON.stringify(evidence)}\nnot-json`), {
    code: "CLOUD_BROWSER_EVIDENCE_JSON_INVALID",
  });
});

test("machine reporter emits one strict JSON object after cross-checking one test and attachment", () => {
  const lines = [];
  const reporter = new CloudEvidenceReporter({
    runId: RUN_ID,
    writeLine: (line) => lines.push(line),
  });
  const testCase = expectedTest();
  reporter.onBegin(reporterConfig(), { allTests: () => [testCase] });
  reporter.onTestEnd(testCase, {
    status: "passed",
    retry: 0,
    attachments: [evidenceAttachment()],
  });
  const override = reporter.onEnd({ status: "passed" });
  assert.equal(override, undefined);
  assert.equal(lines.length, 1);
  const evidence = assertCloudBrowserEvidencePassed(parseCloudBrowserEvidence(lines[0]));
  assert.equal(evidence.run_id, RUN_ID);
  assert.equal(reporter.printsToStdio(), true);
});

test("machine reporter fails closed on retry, skip, extra artifact or worker stdout", () => {
  for (const scenario of ["retry", "skip", "artifact", "stdout"]) {
    const lines = [];
    const reporter = new CloudEvidenceReporter({
      runId: RUN_ID,
      writeLine: (line) => lines.push(line),
    });
    const testCase = expectedTest();
    reporter.onBegin(reporterConfig(), { allTests: () => [testCase] });
    const attachments = [
      evidenceAttachment(scenario === "retry" ? passedEvidence({ retries: 1 }) : passedEvidence()),
      ...(scenario === "artifact"
        ? [{ name: "trace", contentType: "application/zip", path: "/private/trace.zip" }]
        : []),
    ];
    reporter.onTestEnd(testCase, {
      status: scenario === "skip" ? "skipped" : "passed",
      retry: scenario === "retry" ? 1 : 0,
      attachments,
    });
    if (scenario === "stdout") reporter.onStdOut();
    const override = reporter.onEnd({ status: scenario === "skip" ? "failed" : "passed" });
    assert.deepEqual(override, { status: "failed" });
    assert.equal(lines.length, 1);
    const evidence = parseCloudBrowserEvidence(lines[0]);
    assert.throws(() => assertCloudBrowserEvidencePassed(evidence), {
      code: "CLOUD_BROWSER_EVIDENCE_NOT_PASSED",
    });
    assert.doesNotMatch(lines[0], /private|trace\.zip/u);
  }
});
