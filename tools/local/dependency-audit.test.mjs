import assert from "node:assert/strict";
import test from "node:test";
import { DEPENDENCY_AUDIT_EXCEPTIONS, assertDependencyAuditPolicy } from "./dependency-audit.mjs";

function finding(version, dev, paths, overrides = {}) {
  return { version, dev, optional: false, bundled: false, paths, ...overrides };
}

function advisory(id, overrides = {}) {
  const policy = DEPENDENCY_AUDIT_EXCEPTIONS[id];
  const grouped = new Map();
  for (const expected of policy.findings) {
    const key = JSON.stringify([
      expected.version,
      expected.dev,
      expected.optional,
      expected.bundled,
    ]);
    const current = grouped.get(key) ?? [];
    grouped.set(key, [...current, expected.path]);
  }
  return {
    github_advisory_id: id,
    module_name: policy.moduleName,
    severity: policy.severity,
    vulnerable_versions: policy.vulnerableVersions,
    patched_versions: policy.patchedVersions,
    findings: [...grouped.entries()].map(([key, paths]) => {
      const [version, dev, optional, bundled] = JSON.parse(key);
      return finding(version, dev, paths, { optional, bundled });
    }),
    ...overrides,
  };
}

function report(advisories) {
  return {
    advisories: Object.fromEntries(advisories.map((entry, index) => [String(index + 1), entry])),
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: advisories.length,
        high: 0,
        critical: 0,
      },
    },
  };
}

function errorCode(expected) {
  return (error) => error?.code === expected;
}

test("keeps the reviewed exception inventory exact and review-visible", () => {
  assert.deepEqual(DEPENDENCY_AUDIT_EXCEPTIONS, {
    "GHSA-67mh-4wv8-2f99": {
      moduleName: "esbuild",
      severity: "moderate",
      vulnerableVersions: "<=0.24.2",
      patchedVersions: ">=0.24.3",
      findings: [
        {
          version: "0.18.20",
          dev: true,
          optional: false,
          bundled: false,
          path: ".>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild",
        },
        {
          version: "0.18.20",
          dev: true,
          optional: false,
          bundled: false,
          path: "packages__db>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild",
        },
      ],
    },
    "GHSA-w5hq-g745-h8pq": {
      moduleName: "uuid",
      severity: "moderate",
      vulnerableVersions: "<11.1.1",
      patchedVersions: ">=11.1.1",
      findings: [
        {
          version: "8.3.2",
          dev: false,
          optional: false,
          bundled: false,
          path: ".>exceljs>uuid",
        },
        {
          version: "9.0.1",
          dev: false,
          optional: false,
          bundled: false,
          path: ".>tencentcloud-sdk-nodejs-sms>tencentcloud-sdk-nodejs-common>uuid",
        },
      ],
    },
  });
});

test("accepts a clean report and only the two reviewed moderate exceptions", () => {
  assert.deepEqual(assertDependencyAuditPolicy(report([])), {
    high: 0,
    critical: 0,
    acceptedExceptions: [],
  });

  const ids = Object.keys(DEPENDENCY_AUDIT_EXCEPTIONS);
  assert.deepEqual(assertDependencyAuditPolicy(report(ids.map((id) => advisory(id)))), {
    high: 0,
    critical: 0,
    acceptedExceptions: [...ids].sort(),
  });
});

test("rejects every unreviewed advisory, including a new moderate", () => {
  const unexpected = {
    github_advisory_id: "GHSA-new-advisory",
    module_name: "new-package",
    severity: "moderate",
    vulnerable_versions: "<2.0.0",
    patched_versions: ">=2.0.0",
    findings: [finding("1.0.0", false, [".>new-package"])],
  };
  assert.throws(
    () => assertDependencyAuditPolicy(report([unexpected])),
    errorCode("DEPENDENCY_AUDIT_ADVISORY_UNEXPECTED:GHSA-new-advisory"),
  );
});

test("rejects severity or advisory-range drift on an allowed GHSA", () => {
  const id = "GHSA-67mh-4wv8-2f99";
  assert.throws(
    () => assertDependencyAuditPolicy(report([advisory(id, { severity: "high" })])),
    errorCode(`DEPENDENCY_AUDIT_ADVISORY_DRIFT:${id}`),
  );
  assert.throws(
    () => assertDependencyAuditPolicy(report([advisory(id, { patched_versions: ">=0.24.4" })])),
    errorCode(`DEPENDENCY_AUDIT_ADVISORY_DRIFT:${id}`),
  );
});

test("rejects version, dependency-path, and reachability-flag expansion", () => {
  const id = "GHSA-w5hq-g745-h8pq";
  for (const changedFinding of [
    finding("8.3.3", false, [".>exceljs>uuid"]),
    finding("8.3.2", false, [".>new-exporter>uuid"]),
    finding("8.3.2", true, [".>exceljs>uuid"]),
    finding("8.3.2", false, [".>exceljs>uuid"], { optional: true }),
  ]) {
    assert.throws(
      () => assertDependencyAuditPolicy(report([advisory(id, { findings: [changedFinding] })])),
      errorCode(`DEPENDENCY_AUDIT_PATH_DRIFT:${id}`),
    );
  }
});

test("accepts partial remediation but rejects duplicate findings", () => {
  const id = "GHSA-w5hq-g745-h8pq";
  const onePath = finding("8.3.2", false, [".>exceljs>uuid"]);
  assert.equal(
    assertDependencyAuditPolicy(report([advisory(id, { findings: [onePath] })]))
      .acceptedExceptions[0],
    id,
  );
  assert.throws(
    () => assertDependencyAuditPolicy(report([advisory(id, { findings: [onePath, onePath] })])),
    errorCode(`DEPENDENCY_AUDIT_FINDINGS_DUPLICATED:${id}`),
  );
});

test("rejects metadata drift and malformed audit reports", () => {
  const current = report([advisory("GHSA-67mh-4wv8-2f99")]);
  current.metadata.vulnerabilities.high = 1;
  assert.throws(
    () => assertDependencyAuditPolicy(current),
    errorCode("DEPENDENCY_AUDIT_METADATA_DRIFT"),
  );
  assert.throws(
    () => assertDependencyAuditPolicy({ advisories: [] }),
    errorCode("DEPENDENCY_AUDIT_REPORT_INVALID"),
  );
});
