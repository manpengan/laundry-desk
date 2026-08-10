import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CLOUD_WEB_ORIGIN,
  assertCloudBrowserConfiguration,
  cloudBrowserMachineJsonRequested,
  createCloudBrowserRun,
  loadCloudBrowserEnvironment,
} from "./cloud-web-browser-boundary.mjs";

const DIRECT_CREDENTIALS = Object.freeze({
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "cloud-admin",
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Cloud Admin",
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "admin-password",
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: "123456",
  LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "cloud-approver",
  LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "Cloud Approver",
  LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "approver-password",
  LAUNDRY_BOOTSTRAP_APPROVER_PIN: "654321",
});

function code(error) {
  return error !== null && typeof error === "object" && "code" in error ? error.code : null;
}

test("cloud browser origin is fixed and cannot be redirected to local or another host", () => {
  assert.equal(CLOUD_WEB_ORIGIN, "https://desk.manpengan.xyz");
  for (const name of [
    "LAUNDRY_PUBLIC_ORIGIN",
    "LAUNDRY_WEB_URL",
    "LAUNDRY_API_URL",
    "PLAYWRIGHT_TEST_BASE_URL",
  ]) {
    assert.equal(
      assertCloudBrowserConfiguration({ [name]: CLOUD_WEB_ORIGIN }).origin,
      CLOUD_WEB_ORIGIN,
    );
    for (const rejected of ["http://127.0.0.1:5173", "http://localhost:8787", "https://other.test"])
      assert.throws(
        () => assertCloudBrowserConfiguration({ [name]: rejected }),
        (error) => code(error) === "CLOUD_BROWSER_ORIGIN_OVERRIDE_REJECTED",
      );
  }
});

test("cloud browser rejects database environment and requires an exact opt-in", () => {
  for (const name of [
    "DATABASE_URL",
    "LAUNDRY_DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSERVICE",
  ]) {
    assert.throws(
      () => assertCloudBrowserConfiguration({ [name]: "sentinel" }),
      (error) => code(error) === "CLOUD_BROWSER_DATABASE_ENV_REJECTED",
    );
  }
  assert.equal(assertCloudBrowserConfiguration({}).enabled, false);
  assert.equal(cloudBrowserMachineJsonRequested({}), false);
  assert.throws(
    () => assertCloudBrowserConfiguration({ LAUNDRY_CLOUD_WEB_E2E: "true" }),
    (error) => code(error) === "CLOUD_BROWSER_OPT_IN_INVALID",
  );
  assert.throws(
    () => assertCloudBrowserConfiguration({ LAUNDRY_CLOUD_WEB_MACHINE_JSON: "json" }),
    (error) => code(error) === "CLOUD_BROWSER_MACHINE_JSON_INVALID",
  );
  assert.equal(cloudBrowserMachineJsonRequested({ LAUNDRY_CLOUD_WEB_MACHINE_JSON: "1" }), true);
  assert.throws(
    () => loadCloudBrowserEnvironment({ ...DIRECT_CREDENTIALS }),
    (error) => code(error) === "CLOUD_BROWSER_OPT_IN_REQUIRED",
  );
  const live = loadCloudBrowserEnvironment({
    ...DIRECT_CREDENTIALS,
    LAUNDRY_CLOUD_WEB_E2E: "1",
  });
  assert.equal(live.origin, CLOUD_WEB_ORIGIN);
  assert.equal(
    live.credentials.admin.username,
    DIRECT_CREDENTIALS.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME,
  );
  assert.equal(
    live.credentials.approver.username,
    DIRECT_CREDENTIALS.LAUNDRY_BOOTSTRAP_APPROVER_USERNAME,
  );
});

test("read-only subset run id is deterministic and contains no business locator", () => {
  const run = createCloudBrowserRun({
    now: () => new Date("2026-08-10T12:34:56.000Z"),
    randomUUID: () => "12345678-1234-4567-89ab-1234567890ab",
  });
  assert.deepEqual(run, { runId: "CLOUD-BROWSER-20260810T123456Z-12345678" });
  assert.doesNotMatch(JSON.stringify(run), /phone|customer|catalog|order|member/iu);
});

test("cloud Playwright is a read-only subset and cannot claim standalone completion", async () => {
  const root = new URL("../../", import.meta.url);
  const [config, fixture, reporter, spec] = await Promise.all([
    readFile(new URL("apps/web/playwright.cloud.config.ts", root), "utf8"),
    readFile(new URL("apps/web/e2e-cloud/cloud-fixture.mjs", root), "utf8"),
    readFile(new URL("apps/web/e2e-cloud/cloud-evidence-reporter.mjs", root), "utf8"),
    readFile(new URL("apps/web/e2e-cloud/core-ui-subset.spec.mjs", root), "utf8"),
  ]);
  assert.match(config, /baseURL:\s*CLOUD_WEB_ORIGIN/u);
  assert.match(config, /trace:\s*"off"/u);
  assert.match(config, /screenshot:\s*"off"/u);
  assert.match(config, /video:\s*"off"/u);
  assert.match(config, /acceptDownloads:\s*false/u);
  assert.match(config, /workers:\s*1/u);
  assert.match(config, /evidenceRole:\s*"core_ui_subset"/u);
  assert.match(config, /standaloneCompletion:\s*false/u);
  assert.match(config, /completionAuthority:\s*"adr36_api_acceptance_plus_core_ui_subset"/u);
  assert.match(config, /cloudConfiguration\.machineJson/u);
  assert.match(config, /cloud-evidence-reporter\.mjs/u);
  assert.match(config, /test-results\/cloud-web/u);
  assert.doesNotMatch(config, /webServer/u);
  assert.doesNotMatch(fixture, /loadLocalConfig|global-setup|from\s+["'][^"']*\bpg\b/iu);
  assert.doesNotMatch(fixture, /createAcceptanceClient|customer\.anonymize|catalog\.item\.upsert/u);
  assert.match(fixture, /"core_ui_subset"/u);
  assert.match(fixture, /journey:\s*"business_cleanup",\s*status:\s*"NOT_REQUIRED"/u);
  assert.match(fixture, /journey:\s*"standalone_completion",\s*status:\s*"NOT_AUTHORIZED"/u);
  assert.match(fixture, /testInfo\.attach/u);
  assert.match(reporter, /attachments\.length\s*!==\s*1/u);
  assert.match(reporter, /observation\.retry\s*===\s*0/u);
  assert.match(spec, /core_ui_subset:/u);
  assert.match(spec, /read-only subset must not issue product commands/u);
  assert.doesNotMatch(spec, /catalog-save-btn|确认开单|扫码上架|确认取衣|开通会员账户|确认导出/u);
  assert.doesNotMatch(
    `${config}\n${fixture}\n${reporter}\n${spec}`,
    /\b(?:COMPLETE|COMPLETED|OVERALL_PASS)\b/u,
  );
  assert.doesNotMatch(spec, /BOOTSTRAP.*(?:PASSWORD|PIN)|storageState|screenshot/u);
});
