import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertDependencyAuditPolicy } from "./dependency-audit.mjs";
import { DEPENDENCY_AUDIT_PATCHES } from "./dependency-patch-policy.mjs";
import {
  assertInstalledPatch,
  resolvePatchedEntry,
  verifyDependencyPatches,
} from "./dependency-patch-verifier.mjs";

const cwd = process.cwd();
const ids = Object.keys(DEPENDENCY_AUDIT_PATCHES);

function patchedReport(id, overrides = {}) {
  const policy = DEPENDENCY_AUDIT_PATCHES[id];
  return {
    advisories: {
      1: {
        github_advisory_id: id,
        module_name: policy.moduleName,
        severity: policy.severity,
        vulnerable_versions: policy.vulnerableVersions,
        patched_versions: policy.patchedVersions,
        findings: policy.findings.map(({ path, ...finding }) => ({ ...finding, paths: [path] })),
        ...overrides,
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
  };
}

function tempDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), "laundry-dependency-patch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configFixture(t) {
  const dir = tempDirectory(t);
  mkdirSync(join(dir, "patches"));
  const files = [
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    ...ids.map((id) => {
      const policy = DEPENDENCY_AUDIT_PATCHES[id];
      return `patches/${policy.moduleName}@${policy.findings[0].version}.patch`;
    }),
  ];
  for (const file of files) writeFileSync(join(dir, file), readFileSync(join(cwd, file)));
  return dir;
}

test("patch inventory is pinned to the two reviewed releases and exact source digests", () => {
  assert.deepEqual([...ids].sort(), ["GHSA-ch52-4w7c-c8xp", "GHSA-vfj7-8cjw-p6xm"]);
  assert.deepEqual(
    ids.map((id) => {
      const p = DEPENDENCY_AUDIT_PATCHES[id];
      return [p.moduleName, p.findings[0].version, p.findings.length, p.patchSha256];
    }),
    [
      [
        "http-cache-semantics",
        "4.2.0",
        2,
        "f64e8e5cfcb3deaad6c544854b1919e80115f1054d83c48d8fe2895686fec1ff",
      ],
      ["braces", "3.0.3", 10, "8b33a51c3e479bf6a452e56af086fabf2f2d9c8de3cb4796b6b3bf3129e5ac98"],
    ],
  );
});

test("installed transitive packages block stale disclosure and bounded-pattern stack exhaustion", () => {
  assert.deepEqual(verifyDependencyPatches(cwd), [...ids].sort());
});

test("HIGH advisories stay blocked without verified patch evidence", () => {
  for (const id of ids) {
    assert.throws(() => assertDependencyAuditPolicy(patchedReport(id)), {
      code: `DEPENDENCY_AUDIT_PATCH_UNVERIFIED:${id}`,
    });
    const result = assertDependencyAuditPolicy(patchedReport(id), verifyDependencyPatches(cwd));
    assert.deepEqual(result, {
      high: 0,
      critical: 0,
      registryHigh: 1,
      locallyPatched: [id],
      acceptedExceptions: [],
    });
  }
});

test("patch recognition still rejects severity, range, version, path, and reachability drift", () => {
  const verified = verifyDependencyPatches(cwd);
  for (const id of ids) {
    const base = patchedReport(id).advisories["1"];
    for (const override of [
      { severity: "critical" },
      { patched_versions: ">=99.0.0" },
      { findings: [{ ...base.findings[0], version: "0.0.0" }] },
      { findings: [{ ...base.findings[0], paths: [".>unreviewed>" + base.module_name] }] },
      { findings: [{ ...base.findings[0], dev: false }] },
    ])
      assert.throws(() => assertDependencyAuditPolicy(patchedReport(id, override), verified));
  }
});

test("missing or altered patch files and lock/config wiring fail before package loading", (t) => {
  const id = "GHSA-ch52-4w7c-c8xp";
  const policy = DEPENDENCY_AUDIT_PATCHES[id];
  for (const target of ["patch", "workspace", "lock", "reference", "snapshot"]) {
    const dir = configFixture(t);
    const relative =
      target === "patch"
        ? "patches/http-cache-semantics@4.2.0.patch"
        : target === "workspace"
          ? "pnpm-workspace.yaml"
          : "pnpm-lock.yaml";
    const path = join(dir, relative);
    const source = readFileSync(path, "utf8");
    const replacement =
      target === "patch"
        ? source + "\n"
        : target === "workspace"
          ? source.replace(
              "http-cache-semantics@4.2.0: patches/http-cache-semantics@4.2.0.patch",
              "http-cache-semantics@4.2.0: absent.patch",
            )
          : target === "reference"
            ? source.replace(
                `http-cache-semantics: 4.2.0(patch_hash=${policy.patchSha256})`,
                "http-cache-semantics: 4.2.0",
              )
            : target === "snapshot"
              ? source.replace(
                  `  http-cache-semantics@4.2.0(patch_hash=${policy.patchSha256}):`,
                  "  http-cache-semantics@4.2.0:",
                )
              : source.replace(
                  `  http-cache-semantics@4.2.0: ${policy.patchSha256}`,
                  "  http-cache-semantics@4.2.0: wrong",
                );
    assert.notEqual(source, replacement);
    writeFileSync(path, replacement);
    assert.throws(() => verifyDependencyPatches(dir), {
      message: `DEPENDENCY_PATCH_VERIFICATION_FAILED:${id}`,
    });
  }
  const missing = configFixture(t);
  rmSync(join(missing, "patches/http-cache-semantics@4.2.0.patch"));
  assert.throws(() => verifyDependencyPatches(missing), {
    message: `DEPENDENCY_PATCH_VERIFICATION_FAILED:${id}`,
  });
});

test("a package with the right name/version but unreviewed source cannot pass", (t) => {
  for (const id of ids) {
    const policy = DEPENDENCY_AUDIT_PATCHES[id];
    const actual = dirname(resolvePatchedEntry(cwd, policy.findings[0].path));
    const dir = tempDirectory(t);
    for (const file of ["package.json", ...Object.keys(policy.files)]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), readFileSync(join(actual, file)));
    }
    assert.doesNotThrow(() => assertInstalledPatch(join(dir, "index.js"), policy));
    const target = join(dir, Object.keys(policy.files).at(-1));
    writeFileSync(target, readFileSync(target, "utf8") + "\n");
    assert.throws(() => assertInstalledPatch(join(dir, "index.js"), policy), {
      message: "DEPENDENCY_PATCH_SOURCE_MISMATCH",
    });
  }
});

test("container dependency installation receives the reviewed patches", () => {
  for (const file of ["apps/server/Dockerfile", "apps/server/Dockerfile.runtime"]) {
    const source = readFileSync(join(cwd, file), "utf8");
    assert.match(source, /COPY patches patches[\s\S]*RUN pnpm install --frozen-lockfile/);
  }
});
