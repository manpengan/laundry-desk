import { expect, test as base } from "@playwright/test";

import { requireThat } from "../../../tools/cloud/adr36-web-core.mjs";
import {
  CLOUD_WEB_ORIGIN,
  cloudBrowserMachineJsonRequested,
  loadCloudBrowserEnvironment,
} from "../../../tools/cloud/cloud-web-browser-boundary.mjs";
import {
  CLOUD_BROWSER_EVIDENCE_ATTACHMENT,
  CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE,
  createCloudBrowserEvidence,
  requireCloudBrowserRunId,
} from "../../../tools/cloud/cloud-web-browser-evidence.mjs";

const REFRESH_COOKIE = "__Host-laundry_refresh";
const CSRF_COOKIE = "__Host-laundry_csrf";

function safeStatus(machineJson, runId, label, status) {
  if (!machineJson) process.stdout.write(`${runId} ${label} ${status}\n`);
}

async function logoutBrowserContext(context) {
  const cookies = await context.cookies(CLOUD_WEB_ORIGIN);
  const refresh = cookies.find((cookie) => cookie.name === REFRESH_COOKIE);
  const csrf = cookies.find((cookie) => cookie.name === CSRF_COOKIE);
  if (refresh === undefined && csrf === undefined) return;
  requireThat(refresh !== undefined && csrf !== undefined, "CLOUD_BROWSER_LOGOUT_UNSAFE");
  const response = await context.request.post(`${CLOUD_WEB_ORIGIN}/api/v2/auth/logout`, {
    data: {},
    headers: {
      origin: CLOUD_WEB_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrf.value,
    },
    maxRedirects: 0,
  });
  requireThat(response.ok(), "CLOUD_BROWSER_LOGOUT_INCOMPLETE");
  const remaining = await context.cookies(CLOUD_WEB_ORIGIN);
  requireThat(
    remaining.every((cookie) => cookie.name !== REFRESH_COOKIE && cookie.name !== CSRF_COOKIE),
    "CLOUD_BROWSER_LOGOUT_INCOMPLETE",
  );
}

export const test = base.extend({
  cloudRun: [
    async ({}, use, workerInfo) => {
      const runId = requireCloudBrowserRunId(workerInfo.config.metadata.cloudBrowserRunId);
      const machineJson = cloudBrowserMachineJsonRequested(process.env);
      let environment;
      try {
        environment = loadCloudBrowserEnvironment(process.env);
        safeStatus(machineJson, runId, "configuration", "PASS");
      } catch (error) {
        safeStatus(machineJson, runId, "configuration", "FAIL");
        throw error;
      }
      const signIn = async (page) => {
        await page.goto("/");
        requireThat(
          new URL(page.url()).origin === CLOUD_WEB_ORIGIN,
          "CLOUD_BROWSER_REDIRECT_REJECTED",
        );
        await page.locator('input[name="org_code"]').fill("local");
        await page.locator('input[name="store_code"]').fill("main");
        await page.locator('input[name="username"]').fill(environment.credentials.admin.username);
        await page.locator('input[name="password"]').fill(environment.credentials.admin.password);
        await page.getByRole("button", { name: "登录" }).click();
        await expect(page.locator('[data-shell="counter"]')).toBeVisible();
      };
      await use(Object.freeze({ machineJson, runId, signIn }));
    },
    { scope: "worker" },
  ],
  cloudPage: async ({ page, context, cloudRun }, use, testInfo) => {
    let logoutStatus = "PASS";
    try {
      await use(page);
    } finally {
      try {
        await logoutBrowserContext(context);
      } catch {
        logoutStatus = "FAIL";
      }
      const subsetStatus =
        testInfo.status === testInfo.expectedStatus && logoutStatus === "PASS" ? "PASS" : "FAIL";
      const testStatus = testInfo.status === "skipped" ? "SKIPPED" : subsetStatus;
      const results = Object.freeze([
        Object.freeze({ journey: "configuration", status: "PASS" }),
        Object.freeze({ journey: "core_ui_subset", status: subsetStatus }),
        Object.freeze({ journey: "session_logout", status: logoutStatus }),
        Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
        Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
      ]);
      const evidence = createCloudBrowserEvidence({
        runId: cloudRun.runId,
        testCount: 1,
        testTitle: testInfo.title,
        testStatus,
        retries: testInfo.retry,
        results,
      });
      await testInfo.attach(CLOUD_BROWSER_EVIDENCE_ATTACHMENT, {
        body: Buffer.from(JSON.stringify(evidence), "utf8"),
        contentType: CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE,
      });
      safeStatus(cloudRun.machineJson, cloudRun.runId, "core_ui_subset", subsetStatus);
      safeStatus(cloudRun.machineJson, cloudRun.runId, "session_logout", logoutStatus);
      safeStatus(cloudRun.machineJson, cloudRun.runId, "business_cleanup", "NOT_REQUIRED");
      safeStatus(cloudRun.machineJson, cloudRun.runId, "standalone_completion", "NOT_AUTHORIZED");
      requireThat(logoutStatus === "PASS", "CLOUD_BROWSER_LOGOUT_INCOMPLETE");
    }
  },
});

export { expect };
