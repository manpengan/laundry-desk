import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = new URL("../../", import.meta.url);
const readRepositoryFile = (path) => readFile(new URL(path, repository), "utf8");

test("required macOS CI builds and smokes the unsigned software package", async () => {
  const [workflow, rootSource, edgeSource, config, smoke, edgeTypeScript] = await Promise.all([
    readRepositoryFile(".github/workflows/foundation.yml"),
    readRepositoryFile("package.json"),
    readRepositoryFile("apps/edge-agent/package.json"),
    readRepositoryFile("apps/edge-agent/playwright.electron.package.config.ts"),
    readRepositoryFile("apps/edge-agent/e2e/package-mac.spec.ts"),
    readRepositoryFile("apps/edge-agent/tsconfig.e2e.json"),
  ]);
  const rootPackage = JSON.parse(rootSource);
  const edgePackage = JSON.parse(edgeSource);
  const jobMarker = "  runtime-app-macos:\n";
  const jobStart = workflow.indexOf(jobMarker);
  const macJob = jobStart === -1 ? null : workflow.slice(jobStart + jobMarker.length);

  assert.ok(macJob, "required runtime-app-macos job must exist");
  assert.match(macJob, /pnpm install --frozen-lockfile/u);
  assert.match(macJob, /pnpm run local:mac:software:acceptance/u);
  assert.doesNotMatch(macJob, /release:mac|notary|cloud:release|upload-artifact/iu);
  assert.equal(
    rootPackage.scripts["local:mac:software:acceptance"],
    "pnpm local:mac:build && pnpm --filter @laundry/edge-agent package:inspect:mac && pnpm --filter @laundry/edge-agent package:smoke:mac",
  );
  assert.equal(edgePackage.scripts["package:inspect:mac"], "node scripts/inspect-packaged-mac.mjs");
  assert.equal(
    edgePackage.scripts["package:smoke:mac"],
    "pnpm exec playwright test -c playwright.electron.package.config.ts",
  );
  assert.match(config, /testMatch:\s*"package-mac\.spec\.ts"/u);
  for (const mode of ["trace", "screenshot", "video"]) {
    assert.match(config, new RegExp(`${mode}: "off"`, "u"));
  }
  assert.match(edgeTypeScript, /playwright\.electron\.package\.config\.ts/u);
  assert.match(smoke, /credentialFreeEnvironment/u);
  assert.match(smoke, /--use-mock-keychain/u);
  assert.doesNotMatch(smoke, /PASSWORD|PIN|TOKEN|SECRET|LAUNDRY_MAC_APP_PATH/u);
});
