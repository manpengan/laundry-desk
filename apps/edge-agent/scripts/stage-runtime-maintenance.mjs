import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function bounded(path, maximum) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximum ||
    (await realpath(path)) !== path
  )
    throw new Error("MAINTENANCE_BINDING_FILE_INVALID");
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error("MAINTENANCE_BINDING_FILE_CHANGED");
  return bytes;
}
export async function stageRuntimeMaintenance({
  entryDirectory,
  expectedGitSha,
  packageRoot = PACKAGE_ROOT,
  trustPath = join(REPO_ROOT, "tools/windows-runtime/runtime-entry-trust.ps1"),
} = {}) {
  const destination = join(packageRoot, "dist/maintenance/runtime-binding.js");
  if (entryDirectory === undefined) {
    await writeFile(destination, "export const RUNTIME_MAINTENANCE_BINDING = null;\n");
    return { enabled: false };
  }
  if (
    !isAbsolute(entryDirectory) ||
    resolve(entryDirectory) !== entryDirectory ||
    !/^[a-f0-9]{40}$/u.test(expectedGitSha ?? "")
  )
    throw new Error("MAINTENANCE_BINDING_ARGS_INVALID");
  const evidence = JSON.parse(await bounded(join(entryDirectory, "release-evidence.json"), 32768));
  if (
    evidence.schema !== "laundry.windows.runtime-operator-entry" ||
    evidence.version !== 1 ||
    evidence.assurance !== "development_only" ||
    evidence.source_git_sha !== expectedGitSha ||
    !/^[a-f0-9]{64}$/u.test(evidence.manifest_sha256) ||
    !/^[a-f0-9]{64}$/u.test(evidence.entry_sha256)
  )
    throw new Error("MAINTENANCE_BINDING_RELEASE_INVALID");
  const entry = await bounded(join(entryDirectory, "runtime-entry.ps1"), 262144);
  if (sha(entry) !== evidence.entry_sha256) throw new Error("MAINTENANCE_BINDING_ENTRY_CHANGED");
  const trust = (await bounded(trustPath, 16384))
    .toString("utf8")
    .replaceAll("LaundryRuntimeEntryTrust", "LaundryCounterMaintenanceTrust");
  const binding = {
    manifest_sha256: evidence.manifest_sha256,
    entry_sha256: evidence.entry_sha256,
    entry_size: entry.length,
    source_git_sha: expectedGitSha,
    trust_script: trust,
  };
  await writeFile(
    destination,
    `export const RUNTIME_MAINTENANCE_BINDING = Object.freeze(${JSON.stringify(binding)});\n`,
  );
  return {
    enabled: true,
    source_git_sha: expectedGitSha,
    manifest_sha256: evidence.manifest_sha256,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("MAINTENANCE_BINDING_ARGS_INVALID");
    console.log(
      JSON.stringify(
        await stageRuntimeMaintenance({
          entryDirectory: process.env.LAUNDRY_WINDOWS_RUNTIME_ENTRY,
          expectedGitSha: process.env.LAUNDRY_WINDOWS_BUILD_GIT_SHA,
        }),
      ),
    );
  } catch {
    console.error("MAINTENANCE_BINDING_FAILED");
    process.exitCode = 1;
  }
}
