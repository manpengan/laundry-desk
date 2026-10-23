import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeMaintenanceBinding,
  renderRuntimeMaintenanceBinding,
} from "./runtime-maintenance-binding.mjs";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
export async function stageRuntimeMaintenance({
  entryDirectory,
  expectedGitSha,
  packageRoot = PACKAGE_ROOT,
  trustPath = join(REPO_ROOT, "tools/windows-runtime/runtime-entry-trust.ps1"),
} = {}) {
  const destination = join(packageRoot, "dist/maintenance/runtime-binding.js");
  const binding = await runtimeMaintenanceBinding({ entryDirectory, expectedGitSha, trustPath });
  await writeFile(destination, renderRuntimeMaintenanceBinding(binding));
  return {
    enabled: true,
    source_git_sha: expectedGitSha,
    manifest_sha256: binding.manifest_sha256,
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
