import { createCloudBrowserRun } from "../../../tools/cloud/cloud-web-browser-boundary.mjs";
import {
  CLOUD_BROWSER_EVIDENCE_ATTACHMENT,
  CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE,
  CLOUD_BROWSER_EXPECTED_TEST_TITLE,
  assertCloudBrowserEvidencePassed,
  createCloudBrowserEvidence,
  parseCloudBrowserEvidence,
  requireCloudBrowserRunId,
} from "../../../tools/cloud/cloud-web-browser-evidence.mjs";

const FAILED_RESULTS = Object.freeze([
  Object.freeze({ journey: "configuration", status: "FAIL" }),
  Object.freeze({ journey: "core_ui_subset", status: "FAIL" }),
  Object.freeze({ journey: "session_logout", status: "FAIL" }),
  Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
  Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
]);

function validRunId(value) {
  try {
    return requireCloudBrowserRunId(value);
  } catch {
    return null;
  }
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : 100;
}

function fallbackTitle(testCount, observations) {
  if (testCount === 0) return "NO_TEST";
  if (
    testCount === 1 &&
    observations.length === 1 &&
    observations[0].title === CLOUD_BROWSER_EXPECTED_TEST_TITLE
  ) {
    return CLOUD_BROWSER_EXPECTED_TEST_TITLE;
  }
  return "UNEXPECTED_TEST";
}

function fallbackStatus(observations) {
  return observations.length === 1 && observations[0].status === "skipped" ? "SKIPPED" : "FAIL";
}

function failureEvidence(runId, testCount, observations) {
  const retries = observations.reduce(
    (highest, observation) => Math.max(highest, boundedCount(observation.retry)),
    0,
  );
  return createCloudBrowserEvidence({
    runId,
    testCount: boundedCount(testCount),
    testTitle: fallbackTitle(testCount, observations),
    testStatus: fallbackStatus(observations),
    retries,
    results: FAILED_RESULTS,
  });
}

function parseEvidenceAttachment(observation) {
  if (observation.attachments.length !== 1) return null;
  const attachment = observation.attachments[0];
  if (
    attachment.name !== CLOUD_BROWSER_EVIDENCE_ATTACHMENT ||
    attachment.contentType !== CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE ||
    attachment.path !== undefined ||
    !Buffer.isBuffer(attachment.body)
  ) {
    return null;
  }
  try {
    return assertCloudBrowserEvidencePassed(
      parseCloudBrowserEvidence(attachment.body.toString("utf8")),
    );
  } catch {
    return null;
  }
}

export default class CloudEvidenceReporter {
  constructor(options = {}) {
    const configuredRunId = validRunId(options.runId);
    this.runId = configuredRunId ?? createCloudBrowserRun().runId;
    this.optionValid = configuredRunId !== null;
    this.writeLine = options.writeLine ?? ((line) => process.stdout.write(`${line}\n`));
    this.testCount = 0;
    this.beginValid = false;
    this.observations = Object.freeze([]);
    this.globalErrors = 0;
    this.workerStdout = 0;
  }

  printsToStdio() {
    return true;
  }

  onBegin(config, suite) {
    const tests = suite.allTests();
    this.testCount = boundedCount(tests.length);
    this.beginValid =
      this.optionValid &&
      config.metadata?.cloudBrowserRunId === this.runId &&
      tests.length === 1 &&
      tests[0].title === CLOUD_BROWSER_EXPECTED_TEST_TITLE &&
      config.projects.length === 1 &&
      config.projects[0].retries === 0 &&
      config.workers === 1;
  }

  onStdOut() {
    this.workerStdout += 1;
  }

  onError() {
    this.globalErrors += 1;
  }

  onTestEnd(test, result) {
    this.observations = Object.freeze([
      ...this.observations,
      Object.freeze({
        title: test.title,
        expectedStatus: test.expectedStatus,
        status: result.status,
        retry: result.retry,
        attachments: Object.freeze([...result.attachments]),
      }),
    ]);
  }

  onEnd(result) {
    const observation = this.observations.length === 1 ? this.observations[0] : null;
    const attachment = observation === null ? null : parseEvidenceAttachment(observation);
    const passed =
      this.beginValid &&
      this.globalErrors === 0 &&
      this.workerStdout === 0 &&
      result.status === "passed" &&
      observation !== null &&
      observation.title === CLOUD_BROWSER_EXPECTED_TEST_TITLE &&
      observation.expectedStatus === "passed" &&
      observation.status === "passed" &&
      observation.retry === 0 &&
      attachment !== null &&
      attachment.run_id === this.runId;
    const evidence = passed
      ? attachment
      : failureEvidence(this.runId, this.testCount, this.observations);
    this.writeLine(JSON.stringify(evidence));
    return passed ? undefined : Object.freeze({ status: "failed" });
  }
}
