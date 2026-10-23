import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeMaintenanceBinding,
  renderRuntimeMaintenanceBinding,
} from "./runtime-maintenance-binding.mjs";

export function loadAsar() {
  const builder = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
  return createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
}

export async function inspectRuntimeMaintenanceBinding({
  asarPath,
  entryDirectory,
  expectedGitSha,
}) {
  const binding = await runtimeMaintenanceBinding({ entryDirectory, expectedGitSha });
  // Read the packaged bytes as data. Never import/evaluate code from the artifact under review.
  const bytes = loadAsar().extractFile(asarPath, join("dist", "maintenance", "runtime-binding.js"));
  if (!bytes.equals(Buffer.from(renderRuntimeMaintenanceBinding(binding))))
    throw new Error("MAINTENANCE_BINDING_PACKAGED_MISMATCH");
  return Object.freeze({
    source_git_sha: binding.source_git_sha,
    manifest_sha256: binding.manifest_sha256,
    entry_sha256: binding.entry_sha256,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("MAINTENANCE_BINDING_ARGS_INVALID");
    console.log(
      JSON.stringify(
        await inspectRuntimeMaintenanceBinding({
          asarPath: resolve(process.argv[2]),
          entryDirectory: process.env.LAUNDRY_WINDOWS_RUNTIME_ENTRY,
          expectedGitSha: process.env.LAUNDRY_WINDOWS_BUILD_GIT_SHA,
        }),
      ),
    );
  } catch {
    console.error("MAINTENANCE_BINDING_INSPECTION_FAILED");
    process.exitCode = 1;
  }
}
