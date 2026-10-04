import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DEPENDENCY_AUDIT_PATCHES } from "./dependency-patch-policy.mjs";
import { assertPatchedDependencyBehavior } from "./dependency-patch-probes.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function patchedEntries(contents) {
  const blocks = [...contents.matchAll(/^patchedDependencies:\n((?:[ \t].*\n|\n)*)/gm)];
  if (blocks.length !== 1) throw new Error("DEPENDENCY_PATCH_CONFIG_INVALID");
  return blocks[0][1].split("\n");
}

function assertConfiguration(cwd, policy) {
  const version = policy.findings[0].version;
  const key = `${policy.moduleName}@${version}`;
  const patchPath = `patches/${key}.patch`;
  const workspace = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
  const lock = readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8");
  if (
    sha256(readFileSync(join(cwd, patchPath))) !== policy.patchSha256 ||
    !patchedEntries(workspace).includes(`  ${key}: ${patchPath}`) ||
    !patchedEntries(lock).includes(`  ${key}: ${policy.patchSha256}`)
  )
    throw new Error("DEPENDENCY_PATCH_CONFIG_MISMATCH");
  const snapshots = lock.split("\nsnapshots:\n");
  const snapshotKey = `  ${key}(patch_hash=${policy.patchSha256}):`;
  if (
    snapshots.length !== 2 ||
    !snapshots[1].split("\n").some((line) => line.startsWith(snapshotKey))
  ) {
    throw new Error("DEPENDENCY_PATCH_LOCK_MISMATCH");
  }
  const references = snapshots[1]
    .split("\n")
    .filter((line) => line.startsWith(`      ${policy.moduleName}: `));
  if (
    references.length === 0 ||
    references.some(
      (line) => line !== `      ${policy.moduleName}: ${version}(patch_hash=${policy.patchSha256})`,
    )
  ) {
    throw new Error("DEPENDENCY_PATCH_REFERENCE_MISMATCH");
  }
}

export function assertInstalledPatch(entry, policy) {
  const packageRoot = dirname(entry);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== policy.moduleName || manifest.version !== policy.findings[0].version) {
    throw new Error("DEPENDENCY_PATCH_VERSION_MISMATCH");
  }
  for (const [file, hash] of Object.entries(policy.files)) {
    if (sha256(readFileSync(join(packageRoot, file))) !== hash) {
      throw new Error("DEPENDENCY_PATCH_SOURCE_MISMATCH");
    }
  }
}

export function resolvePatchedEntry(cwd, dependencyPath) {
  const [importer, ...chain] = dependencyPath.split(">");
  let loader = createRequire(
    join(cwd, importer === "." ? "" : importer.replaceAll("__", "/"), "package.json"),
  );
  let entry;
  for (const name of chain) {
    entry = loader.resolve(name);
    loader = createRequire(entry);
  }
  return entry;
}

export function verifyDependencyPatches(cwd) {
  const verified = [];
  for (const [advisoryId, policy] of Object.entries(DEPENDENCY_AUDIT_PATCHES)) {
    try {
      assertConfiguration(cwd, policy);
      const entries = new Set(
        policy.findings.map((finding) => resolvePatchedEntry(cwd, finding.path)),
      );
      for (const entry of entries) {
        assertInstalledPatch(entry, policy);
        assertPatchedDependencyBehavior(policy.moduleName, createRequire(entry)(entry));
      }
      verified.push(advisoryId);
    } catch (cause) {
      throw new Error(`DEPENDENCY_PATCH_VERIFICATION_FAILED:${advisoryId}`, { cause });
    }
  }
  return Object.freeze(verified.sort());
}
