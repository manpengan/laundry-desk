import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_AUDIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const AUDIT_TIMEOUT_MS = 60_000;
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);

function finding(version, dev, path) {
  return Object.freeze({ version, dev, optional: false, bundled: false, path });
}

export const DEPENDENCY_AUDIT_EXCEPTIONS = Object.freeze({
  "GHSA-67mh-4wv8-2f99": Object.freeze({
    moduleName: "esbuild",
    severity: "moderate",
    vulnerableVersions: "<=0.24.2",
    patchedVersions: ">=0.24.3",
    findings: Object.freeze([
      finding(
        "0.18.20",
        true,
        ".>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild",
      ),
      finding(
        "0.18.20",
        true,
        "packages__db>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild",
      ),
    ]),
  }),
  "GHSA-w5hq-g745-h8pq": Object.freeze({
    moduleName: "uuid",
    severity: "moderate",
    vulnerableVersions: "<11.1.1",
    patchedVersions: ">=11.1.1",
    findings: Object.freeze([
      finding("8.3.2", false, ".>exceljs>uuid"),
      finding("9.0.1", false, ".>tencentcloud-sdk-nodejs-sms>tencentcloud-sdk-nodejs-common>uuid"),
    ]),
  }),
});

export class DependencyAuditError extends Error {
  constructor(code) {
    super(code);
    this.name = "DependencyAuditError";
    this.code = code;
  }
}

function fail(code) {
  throw new DependencyAuditError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findingKey(value) {
  return JSON.stringify([value.version, value.dev, value.optional, value.bundled, value.path]);
}

function actualFindingKeys(advisory, advisoryId) {
  if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) {
    fail(`DEPENDENCY_AUDIT_FINDINGS_INVALID:${advisoryId}`);
  }
  const keys = advisory.findings.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.version !== "string" ||
      typeof entry.dev !== "boolean" ||
      typeof entry.optional !== "boolean" ||
      typeof entry.bundled !== "boolean" ||
      !Array.isArray(entry.paths) ||
      entry.paths.length === 0 ||
      entry.paths.some((path) => typeof path !== "string")
    ) {
      fail(`DEPENDENCY_AUDIT_FINDINGS_INVALID:${advisoryId}`);
    }
    return entry.paths.map((path) => findingKey({ ...entry, path }));
  });
  if (new Set(keys).size !== keys.length) {
    fail(`DEPENDENCY_AUDIT_FINDINGS_DUPLICATED:${advisoryId}`);
  }
  return keys;
}

function assertAdvisory(advisory) {
  if (!isRecord(advisory) || typeof advisory.github_advisory_id !== "string") {
    fail("DEPENDENCY_AUDIT_ADVISORY_INVALID");
  }
  const advisoryId = advisory.github_advisory_id;
  const policy = DEPENDENCY_AUDIT_EXCEPTIONS[advisoryId];
  if (policy === undefined) fail(`DEPENDENCY_AUDIT_ADVISORY_UNEXPECTED:${advisoryId}`);
  if (
    advisory.module_name !== policy.moduleName ||
    advisory.severity !== policy.severity ||
    advisory.vulnerable_versions !== policy.vulnerableVersions ||
    advisory.patched_versions !== policy.patchedVersions
  ) {
    fail(`DEPENDENCY_AUDIT_ADVISORY_DRIFT:${advisoryId}`);
  }
  const allowedFindings = new Set(policy.findings.map(findingKey));
  for (const key of actualFindingKeys(advisory, advisoryId)) {
    if (!allowedFindings.has(key)) fail(`DEPENDENCY_AUDIT_PATH_DRIFT:${advisoryId}`);
  }
  return advisoryId;
}

function assertMetadata(report, advisoryCount) {
  const vulnerabilities = report.metadata?.vulnerabilities;
  if (!isRecord(vulnerabilities)) fail("DEPENDENCY_AUDIT_METADATA_INVALID");
  for (const severity of SEVERITIES) {
    if (!Number.isInteger(vulnerabilities[severity]) || vulnerabilities[severity] < 0) {
      fail("DEPENDENCY_AUDIT_METADATA_INVALID");
    }
  }
  if (
    vulnerabilities.info !== 0 ||
    vulnerabilities.low !== 0 ||
    vulnerabilities.high !== 0 ||
    vulnerabilities.critical !== 0 ||
    vulnerabilities.moderate !== advisoryCount
  ) {
    fail("DEPENDENCY_AUDIT_METADATA_DRIFT");
  }
}

export function assertDependencyAuditPolicy(report) {
  if (!isRecord(report) || !isRecord(report.advisories)) {
    fail("DEPENDENCY_AUDIT_REPORT_INVALID");
  }
  const advisoryIds = Object.values(report.advisories).map(assertAdvisory);
  if (new Set(advisoryIds).size !== advisoryIds.length) {
    fail("DEPENDENCY_AUDIT_ADVISORY_DUPLICATED");
  }
  assertMetadata(report, advisoryIds.length);
  return Object.freeze({
    high: 0,
    critical: 0,
    acceptedExceptions: Object.freeze([...advisoryIds].sort()),
  });
}

export async function collectPnpmAudit(cwd = process.cwd()) {
  const output = await new Promise((resolveOutput, rejectOutput) => {
    execFile(
      "pnpm",
      ["audit", "--json"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
        timeout: AUDIT_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error !== null && error.code !== 1) {
          rejectOutput(new DependencyAuditError("DEPENDENCY_AUDIT_COMMAND_FAILED"));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
  try {
    return JSON.parse(output);
  } catch {
    fail("DEPENDENCY_AUDIT_OUTPUT_INVALID");
  }
}

export async function runDependencyAudit(cwd = process.cwd()) {
  return assertDependencyAuditPolicy(await collectPnpmAudit(cwd));
}

async function main() {
  try {
    const summary = await runDependencyAudit();
    const exceptions = summary.acceptedExceptions.join(",") || "none";
    console.log(
      `DEPENDENCY_AUDIT_OK high=${summary.high} critical=${summary.critical} exceptions=${exceptions}`,
    );
  } catch (error) {
    console.error(error instanceof DependencyAuditError ? error.code : "DEPENDENCY_AUDIT_FAILED");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
