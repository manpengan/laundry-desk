import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";

import {
  assertAdr36ApiAcceptancePassed,
  parseAdr36ApiAcceptanceEvidence,
} from "./adr36-web-acceptance-evidence.mjs";
import {
  assertCloudBrowserEvidencePassed,
  parseCloudBrowserEvidence,
} from "./cloud-web-browser-evidence.mjs";
import { assertNoDirectAcceptanceSecrets } from "./hk-vps-release-acceptance-secrets.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import {
  canonicalFinalizeEvidence,
  createFinalizeEvidence,
  parseSingleJsonLine,
} from "./hk-vps-release-finalize-evidence.mjs";
import { withDownloadedAcceptanceCredentials } from "./hk-vps-release-local-credentials.mjs";

const BROWSER_CONFIG = "apps/web/playwright.cloud.config.ts";
const MACHINE_OUTPUT_LIMIT = 64 * 1024;

function requireCleanChildResult(result, code) {
  if (
    typeof result !== "object" ||
    result === null ||
    result.stderr !== "" ||
    !Number.isSafeInteger(result.code)
  ) {
    fail(code);
  }
  return parseSingleJsonLine(result.stdout, MACHINE_OUTPUT_LIMIT, code);
}

export function parseRemoteApiEvidenceResult(result) {
  let evidence;
  try {
    evidence = assertAdr36ApiAcceptancePassed(
      parseAdr36ApiAcceptanceEvidence(
        requireCleanChildResult(result, "CLOUD_RELEASE_API_EVIDENCE_OUTPUT_INVALID"),
      ),
    );
  } catch (error) {
    fail("CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED", error);
  }
  if (result.code !== 0) fail("CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED");
  return evidence;
}

export async function resolvePlaywrightCli(repositoryRoot, dependencies = {}) {
  const canonicalRoot = await (dependencies.realpath ?? realpath)(repositoryRoot);
  const nodeModules = await (dependencies.realpath ?? realpath)(
    join(canonicalRoot, "node_modules"),
  );
  const require = (dependencies.createRequire ?? createRequire)(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const resolved = require.resolve("@playwright/test/cli");
  const canonical = await (dependencies.realpath ?? realpath)(resolved);
  const location = relative(nodeModules, canonical);
  const metadata = await (dependencies.lstat ?? lstat)(canonical);
  const uid = dependencies.uid ?? process.getuid?.();
  if (
    canonicalRoot !== repositoryRoot ||
    !isAbsolute(canonical) ||
    location === "" ||
    location.startsWith("..") ||
    isAbsolute(location) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o022) !== 0 ||
    (await (dependencies.realpath ?? realpath)(canonical)) !== canonical
  ) {
    fail("CLOUD_RELEASE_PLAYWRIGHT_CLI_INVALID");
  }
  return canonical;
}

export async function runLocalBrowserEvidence(input, dependencies = {}) {
  const cli = await (dependencies.resolvePlaywrightCli ?? resolvePlaywrightCli)(input.cwd);
  const result = await input.execute(
    process.execPath,
    [cli, "test", "-c", join(input.cwd, BROWSER_CONFIG)],
    "CLOUD_RELEASE_BROWSER_EVIDENCE",
    5 * 60_000,
    Object.freeze({
      accepting: Object.freeze([0, 1]),
      environment: input.environment,
      maximumOutputBytes: MACHINE_OUTPUT_LIMIT,
    }),
  );
  let evidence;
  try {
    evidence = assertCloudBrowserEvidencePassed(
      parseCloudBrowserEvidence(
        requireCleanChildResult(result, "CLOUD_RELEASE_BROWSER_EVIDENCE_OUTPUT_INVALID"),
      ),
    );
  } catch (error) {
    fail("CLOUD_RELEASE_BROWSER_EVIDENCE_NOT_PASSED", error);
  }
  if (result.code !== 0) fail("CLOUD_RELEASE_BROWSER_EVIDENCE_NOT_PASSED");
  return evidence;
}

export async function collectFinalizeEvidence(input, dependencies = {}) {
  assertNoDirectAcceptanceSecrets(input.environment);
  const api = parseRemoteApiEvidenceResult(await dependencies.runRemoteApiEvidence());
  const download = dependencies.withDownloadedCredentials ?? withDownloadedAcceptanceCredentials;
  const browser = await download(
    Object.freeze({
      environment: input.environment,
      execute: input.execute,
      knownHostsPath: input.knownHostsPath,
      profile: input.profile,
    }),
    async (environment) =>
      await (dependencies.runBrowserEvidence ?? runLocalBrowserEvidence)(
        Object.freeze({ cwd: input.cwd, environment, execute: input.execute }),
      ),
  );
  const now = dependencies.now?.() ?? new Date();
  const evidence = createFinalizeEvidence(
    Object.freeze({
      api,
      browser,
      candidateSha: input.options.candidateSha,
      expectedSha: input.options.expectedSha,
      migrationHead: input.options.migrationHead,
      token: input.options.token,
    }),
    Object.freeze({ now: () => now, randomUUID: dependencies.randomUUID }),
  );
  return Object.freeze({
    evidence,
    canonical: canonicalFinalizeEvidence(evidence, input.options, now),
  });
}
