import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

import {
  assertCloudBrowserConfiguration,
  CLOUD_WEB_ORIGIN,
  createCloudBrowserRun,
} from "../../tools/cloud/cloud-web-browser-boundary.mjs";

const cloudConfiguration = assertCloudBrowserConfiguration(process.env);
const cloudRun = createCloudBrowserRun();
const evidenceReporter = fileURLToPath(
  new URL("./e2e-cloud/cloud-evidence-reporter.mjs", import.meta.url),
);

/** Opt-in public Cloud Web acceptance; it never starts or connects to a local service. */
export default defineConfig({
  testDir: "./e2e-cloud",
  testMatch: "core-ui-subset.spec.mjs",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: cloudConfiguration.machineJson
    ? [[evidenceReporter, { runId: cloudRun.runId }]]
    : [["list"]],
  metadata: {
    evidenceRole: "core_ui_subset",
    standaloneCompletion: false,
    completionAuthority: "adr36_api_acceptance_plus_core_ui_subset",
    cloudBrowserRunId: cloudRun.runId,
  },
  outputDir: "../../test-results/cloud-web",
  use: {
    baseURL: CLOUD_WEB_ORIGIN,
    ignoreHTTPSErrors: false,
    trace: "off",
    screenshot: "off",
    video: "off",
    headless: true,
    acceptDownloads: false,
  },
  projects: [{ name: "chromium-cloud", use: { browserName: "chromium" } }],
});
