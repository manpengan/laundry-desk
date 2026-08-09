import { randomUUID as systemRandomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAcceptanceClient } from "./adr36-web-client.mjs";
import { AcceptanceFailure, failureCode, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { loadAcceptanceCredentials } from "./adr36-web-credentials.mjs";
import {
  cleanupOrderFinanceArtifacts,
  initialOrderFinanceArtifacts,
  orderFinanceJourney,
} from "./adr36-web-order-finance-journey.mjs";
import { reminderHistoryBlockedResult, reportingJourney } from "./adr36-web-reporting-journey.mjs";
import { createStaffCredentialJourney } from "./adr36-web-staff-journey.mjs";
import {
  MAIN_JOURNEYS,
  accountingDeltaJourney,
  authJourney,
  baselineJourney,
  cashOrderJourney,
  catalogJourney,
  cleanupArtifacts,
  customerJourney,
  initialArtifacts,
  logoutSessions,
  memberJourney,
  syntheticRun,
} from "./adr36-web-journeys.mjs";

export { applySetCookieHeaders, createAcceptanceClient } from "./adr36-web-client.mjs";
export { ADR36_PUBLIC_ORIGIN, AcceptanceFailure } from "./adr36-web-core.mjs";
export { loadAcceptanceCredentials, readProtectedSecretFile } from "./adr36-web-credentials.mjs";

function printReport(writeLine, runId, results) {
  writeLine(`ADR36 run-id ${runId}`);
  for (const result of results) {
    const suffix = result.code === undefined ? "" : ` ${result.code}`;
    writeLine(`${result.journey} ${result.status}${suffix}`);
  }
}

const EXTENDED_JOURNEYS = Object.freeze([
  "staff_credentials",
  "order_finance",
  "reporting_exports_shift",
]);

function acceptanceStages(api, credentials, getArtifacts, update, run, extensions) {
  return [
    ["dual_admin_auth", () => authJourney(api, credentials, update)],
    ["staff_credentials", extensions.staff],
    ["accounting_baseline", () => baselineJourney(api, getArtifacts(), update)],
    ["catalog_price", () => catalogJourney(api, getArtifacts(), run, update)],
    ["synthetic_customer", () => customerJourney(api, getArtifacts(), run, update)],
    ["cash_order_fulfillment", () => cashOrderJourney(api, getArtifacts(), run, update)],
    ["member_lifecycle", () => memberJourney(api, credentials, getArtifacts(), run, update)],
    ["accounting_today_delta", () => accountingDeltaJourney(api, getArtifacts())],
    ["order_finance", extensions.orderFinance],
    ["reporting_exports_shift", extensions.reporting],
  ];
}

function expectedBlockedResults() {
  return [reminderHistoryBlockedResult()];
}

function result(journey, status, code) {
  return Object.freeze({
    journey,
    status,
    ...(code === undefined ? {} : { code }),
  });
}

export async function runAcceptance(options = {}) {
  const now = options.now?.() ?? new Date();
  requireThat(now instanceof Date && Number.isFinite(now.getTime()), "CLOCK_INVALID");
  const randomUUID = options.randomUUID ?? systemRandomUUID;
  const runUuid = requireUuid(randomUUID(), "RANDOM_UUID_INVALID");
  const run = syntheticRun(now, runUuid);
  const results = [];
  let artifacts = Object.freeze({ ...initialArtifacts(), ...initialOrderFinanceArtifacts() });
  const getArtifacts = () => artifacts;
  const update = (patch) => {
    artifacts = Object.freeze({ ...artifacts, ...patch });
  };
  let credentials = null;
  let staffController = null;
  let failed = false;
  let primaryCode;

  try {
    credentials = loadAcceptanceCredentials(options.env ?? process.env);
    results.push(result("configuration", "PASS"));
  } catch (error) {
    primaryCode = failureCode(error);
    failed = true;
    results.push(result("configuration", "FAIL", primaryCode));
  }

  const api = createAcceptanceClient({
    fetchImpl: options.fetchImpl,
    randomUUID,
    timeoutMs: options.timeoutMs,
  });
  const staffFactory = options.createStaffJourney ?? createStaffCredentialJourney;
  const runOrderFinance = options.orderFinanceJourney ?? orderFinanceJourney;
  const runReporting = options.reportingJourney ?? reportingJourney;
  const cleanupOrderFinance = options.cleanupOrderFinance ?? cleanupOrderFinanceArtifacts;
  const extensions = Object.freeze({
    staff: async () => {
      const current = getArtifacts();
      staffController = staffFactory({
        api,
        adminSession: current.adminSession,
        approverSession: current.approverSession,
        approverPin: credentials.approver.pin,
        run,
      });
      await staffController.execute();
    },
    orderFinance: () => runOrderFinance(api, credentials, getArtifacts(), run, update),
    reporting: () => {
      const current = getArtifacts();
      return runReporting(api, {
        session: current.adminSession,
        signatureName: run.label.slice(0, 64),
        note: run.note,
        markShiftCleanupUncertain: (value) => {
          requireThat(typeof value === "boolean", "REPORTING_CLEANUP_STATE_INVALID");
          update({ reportingCleanupUncertain: value });
        },
      });
    },
  });
  const stages = acceptanceStages(api, credentials, getArtifacts, update, run, extensions);
  for (const [journey, execute] of stages) {
    if (failed) {
      results.push(result(journey, "FAIL", "DEPENDENCY_FAILED"));
      continue;
    }
    try {
      await execute();
      results.push(result(journey, "PASS"));
    } catch (error) {
      primaryCode = failureCode(error);
      failed = true;
      if (/PIN|AUTHENTICATION|POLICY_DENIED/u.test(primaryCode)) {
        update({ approvalHealthy: false });
      }
      results.push(result(journey, "FAIL", primaryCode));
    }
  }

  results.push(...expectedBlockedResults());
  const orderFinanceCleaned =
    credentials === null ? true : await cleanupOrderFinance(api, getArtifacts(), run, update);
  const staffCleaned = staffController === null ? true : await staffController.cleanup();
  const baseCleaned =
    credentials === null ? true : await cleanupArtifacts(api, credentials, getArtifacts(), run);
  const reportingCleaned = !getArtifacts().reportingCleanupUncertain;
  const authCleaned = !getArtifacts().authCleanupUncertain;
  const cleaned =
    orderFinanceCleaned && staffCleaned && baseCleaned && reportingCleaned && authCleaned;
  results.push(
    result("safe_cleanup", cleaned ? "PASS" : "FAIL", cleaned ? undefined : "CLEANUP_INCOMPLETE"),
  );
  const loggedOut = await logoutSessions(api, artifacts);
  results.push(
    result(
      "session_logout",
      loggedOut ? "PASS" : "FAIL",
      loggedOut ? undefined : "LOGOUT_INCOMPLETE",
    ),
  );
  failed ||= !cleaned || !loggedOut;
  results.push(
    result(
      "overall",
      failed ? "FAIL" : "BLOCKED",
      failed ? (primaryCode ?? "ACCEPTANCE_FAILED") : "PARTIAL_ACCEPTANCE_ONLY",
    ),
  );
  requireThat(
    [...MAIN_JOURNEYS, ...EXTENDED_JOURNEYS].every((journey) =>
      results.some((entry) => entry.journey === journey),
    ),
    "REPORT_INCOMPLETE",
  );
  printReport(
    options.writeLine ?? ((line) => process.stdout.write(`${line}\n`)),
    run.runId,
    results,
  );
  return Object.freeze({
    runId: run.runId,
    results: Object.freeze(results),
    exitCode: failed ? 1 : 2,
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) throw new AcceptanceFailure("ARGUMENTS_NOT_SUPPORTED");
  const report = await runAcceptance();
  process.exitCode = report.exitCode;
}

export function isDirectEntrypoint(entry, moduleUrl) {
  if (entry === "-") return /\/\[eval\d*\]$/u.test(new URL(moduleUrl).pathname);
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

const entry = process.argv[1];
if (isDirectEntrypoint(entry, import.meta.url)) {
  main().catch((error) => {
    process.stdout.write("ADR36 run-id UNAVAILABLE\n");
    process.stdout.write(`startup FAIL ${failureCode(error)}\n`);
    process.exitCode = 1;
  });
}
