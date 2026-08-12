import { randomUUID as systemRandomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAdr36ApiAcceptanceEvidence } from "./adr36-web-acceptance-evidence.mjs";
import { createAcceptanceClient } from "./adr36-web-client.mjs";
import { AcceptanceFailure, failureCode, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { loadAcceptanceCredentials } from "./adr36-web-credentials.mjs";
import {
  cleanupOrderFinanceArtifacts,
  initialOrderFinanceArtifacts,
  orderFinanceJourney,
} from "./adr36-web-order-finance-journey.mjs";
import {
  reminderHistoryBlockedResult,
  reminderHistoryJourney,
  reportingJourney,
} from "./adr36-web-reporting-journey.mjs";
import {
  createReminderHistoryFixture,
  reminderFixtureRequested,
} from "./adr36-web-reminder-fixture.mjs";
import { createStaffCredentialJourney } from "./adr36-web-staff-journey.mjs";
import { createOwnerOperationsJourney } from "./adr40-owner-journey.mjs";
import { createMemberBenefitsJourney } from "./adr41-member-benefits-journey.mjs";
import { createCustomerProfileJourney } from "./adr42-customer-profile-journey.mjs";
import { notificationDeliveryBoundaryJourney } from "./adr44-notification-delivery-journey.mjs";
import { factoryHandoffBoundaryJourney } from "./adr45-factory-handoff-journey.mjs";
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
  "owner_store_operations",
  "staff_credentials",
  "member_benefits",
  "customer_profile_policy",
  "notification_delivery_boundary",
  "factory_handoff_boundary",
  "order_finance",
  "reporting_exports_shift",
  "reminder_history",
]);

function acceptanceStages(api, credentials, getArtifacts, update, run, extensions) {
  return [
    ["dual_admin_auth", () => authJourney(api, credentials, update)],
    ["owner_store_operations", extensions.owner],
    ["staff_credentials", extensions.staff],
    ["accounting_baseline", () => baselineJourney(api, getArtifacts(), update)],
    ["catalog_price", () => catalogJourney(api, getArtifacts(), run, update)],
    ["synthetic_customer", () => customerJourney(api, getArtifacts(), run, update)],
    ["cash_order_fulfillment", () => cashOrderJourney(api, getArtifacts(), run, update)],
    ["member_benefits", extensions.memberBenefits],
    ["customer_profile_policy", extensions.customerProfile],
    ["notification_delivery_boundary", extensions.notificationDelivery],
    ["factory_handoff_boundary", extensions.factoryHandoff],
    ["member_lifecycle", () => memberJourney(api, credentials, getArtifacts(), run, update)],
    ["accounting_today_delta", () => accountingDeltaJourney(api, getArtifacts())],
    ["order_finance", extensions.orderFinance],
    ["reporting_exports_shift", extensions.reporting],
  ];
}

function result(journey, status, code) {
  return Object.freeze({
    journey,
    status,
    ...(code === undefined ? {} : { code }),
  });
}

export async function runAcceptance(options = {}) {
  const outputMode = options.outputMode ?? "human";
  requireThat(/^(human|machine-json)$/u.test(outputMode), "OUTPUT_MODE_INVALID");
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
  let ownerController = null;
  let memberBenefitsController = null;
  let customerProfileController = null;
  let reminderController = null;
  let reminderEnabled = false;
  let reminderPassed = false;
  let failed = false;
  let primaryCode;

  try {
    const env = options.env ?? process.env;
    credentials = loadAcceptanceCredentials(env);
    reminderEnabled = reminderFixtureRequested(env);
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
  const ownerFactory = options.createOwnerJourney ?? createOwnerOperationsJourney;
  const memberBenefitsFactory = options.createMemberBenefitsJourney ?? createMemberBenefitsJourney;
  const customerProfileFactory =
    options.createCustomerProfileJourney ?? createCustomerProfileJourney;
  const runOrderFinance = options.orderFinanceJourney ?? orderFinanceJourney;
  const runReporting = options.reportingJourney ?? reportingJourney;
  const runReminderHistory = options.reminderHistoryJourney ?? reminderHistoryJourney;
  const runNotificationDelivery =
    options.notificationDeliveryJourney ?? notificationDeliveryBoundaryJourney;
  const runFactoryHandoff = options.factoryHandoffJourney ?? factoryHandoffBoundaryJourney;
  const reminderFactory = options.createReminderFixture ?? createReminderHistoryFixture;
  const cleanupOrderFinance = options.cleanupOrderFinance ?? cleanupOrderFinanceArtifacts;
  const extensions = Object.freeze({
    owner: async () => {
      const current = getArtifacts();
      ownerController = ownerFactory({
        api,
        adminSession: current.adminSession,
        approverSession: current.approverSession,
        approverPin: credentials.approver.pin,
        run,
        updateSession: (adminSession) => update({ adminSession }),
      });
      await ownerController.execute();
    },
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
    memberBenefits: async () => {
      const current = getArtifacts();
      memberBenefitsController = memberBenefitsFactory({
        api,
        adminSession: current.adminSession,
        artifacts: current,
        run,
        update,
      });
      await memberBenefitsController.execute();
    },
    customerProfile: async () => {
      const current = getArtifacts();
      customerProfileController = customerProfileFactory({
        api,
        adminSession: current.adminSession,
        approverSession: current.approverSession,
        approverPin: credentials.approver.pin,
        artifacts: current,
        run,
        update,
      });
      await customerProfileController.execute();
    },
    notificationDelivery: () => {
      const current = getArtifacts();
      return runNotificationDelivery(api, { session: current.adminSession });
    },
    factoryHandoff: () => {
      const current = getArtifacts();
      return runFactoryHandoff(api, { session: current.adminSession });
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

  if (!reminderEnabled) {
    results.push(reminderHistoryBlockedResult());
  } else if (failed) {
    results.push(result("reminder_history", "FAIL", "DEPENDENCY_FAILED"));
  } else {
    try {
      const current = getArtifacts();
      reminderController = await reminderFactory({
        env: options.env ?? process.env,
        cwd: options.cwd,
        now,
        run,
        session: current.adminSession,
      });
      const proof = await reminderController.prepare();
      const evidence = await runReminderHistory(
        api,
        Object.freeze({ session: current.adminSession, runId: run.runId }),
        proof,
      );
      await reminderController.verify(evidence);
      reminderPassed = true;
      results.push(result("reminder_history", "PASS"));
    } catch (error) {
      primaryCode = failureCode(error);
      failed = true;
      results.push(result("reminder_history", "FAIL", primaryCode));
    }
  }
  const reminderCleaned = reminderController === null ? true : await reminderController.cleanup();
  const orderFinanceCleaned =
    credentials === null ? true : await cleanupOrderFinance(api, getArtifacts(), run, update);
  const staffCleaned = staffController === null ? true : await staffController.cleanup();
  const memberBenefitsCleaned =
    memberBenefitsController === null ? true : await memberBenefitsController.cleanup();
  const customerProfileCleaned =
    customerProfileController === null ? true : await customerProfileController.cleanup();
  const ownerCleaned = ownerController === null ? true : await ownerController.cleanup();
  const baseCleaned =
    credentials === null ? true : await cleanupArtifacts(api, credentials, getArtifacts(), run);
  const reportingCleaned = !getArtifacts().reportingCleanupUncertain;
  const authCleaned = !getArtifacts().authCleanupUncertain;
  const cleaned =
    reminderCleaned &&
    orderFinanceCleaned &&
    staffCleaned &&
    customerProfileCleaned &&
    memberBenefitsCleaned &&
    ownerCleaned &&
    baseCleaned &&
    reportingCleaned &&
    authCleaned;
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
  const overallStatus = failed ? "FAIL" : reminderPassed ? "PASS" : "BLOCKED";
  const overallCode = failed
    ? (primaryCode ?? "ACCEPTANCE_FAILED")
    : reminderPassed
      ? undefined
      : "PARTIAL_ACCEPTANCE_ONLY";
  results.push(result("overall", overallStatus, overallCode));
  requireThat(
    [...MAIN_JOURNEYS, ...EXTENDED_JOURNEYS].every((journey) =>
      results.some((entry) => entry.journey === journey),
    ),
    "REPORT_INCOMPLETE",
  );
  const report = Object.freeze({
    runId: run.runId,
    results: Object.freeze(results),
    exitCode: failed ? 1 : reminderPassed ? 0 : 2,
  });
  const writeLine = options.writeLine ?? ((line) => process.stdout.write(`${line}\n`));
  if (outputMode === "machine-json") {
    writeLine(JSON.stringify(createAdr36ApiAcceptanceEvidence(report)));
  } else {
    printReport(writeLine, run.runId, results);
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const outputMode =
    argv.length === 0
      ? "human"
      : argv.length === 1 && argv[0] === "--machine-json"
        ? "machine-json"
        : null;
  if (outputMode === null) throw new AcceptanceFailure("ARGUMENTS_NOT_SUPPORTED");
  const report = await runAcceptance({ outputMode });
  process.exitCode = report.exitCode;
}

export function isDirectEntrypoint(entry, moduleUrl) {
  if (entry === "-") return /\/\[eval\d*\]$/u.test(new URL(moduleUrl).pathname);
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

const entry = process.argv[1];
if (isDirectEntrypoint(entry, import.meta.url)) {
  main().catch((error) => {
    if (process.argv.length === 3 && process.argv[2] === "--machine-json") {
      process.stderr.write(`${failureCode(error)}\n`);
    } else {
      process.stdout.write("ADR36 run-id UNAVAILABLE\n");
      process.stdout.write(`startup FAIL ${failureCode(error)}\n`);
    }
    process.exitCode = 1;
  });
}
