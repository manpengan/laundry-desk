import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kitRoot = join(repositoryRoot, "tools/runtime-kit");

const sourceAllowlist = Object.freeze([
  ".gitignore",
  "README.md",
  "Resources/trusted-manifest-public-key.txt",
  "Sources/FakeRuntimeRunner.swift",
  "Sources/FakeStreamingRunner.swift",
  "Sources/LaunchAgent.swift",
  "Sources/ManifestVerifier.swift",
  "Sources/ProcessRunner.swift",
  "Sources/RuntimeBackupCodec.swift",
  "Sources/RuntimeBackupCommands.swift",
  "Sources/RuntimeBackupController.swift",
  "Sources/RuntimeBackupModels.swift",
  "Sources/RuntimeBackupStaging.swift",
  "Sources/RuntimeCLI.swift",
  "Sources/RuntimeCLIDataProtection.swift",
  "Sources/RuntimeCommissionController.swift",
  "Sources/RuntimeCommissionStorage.swift",
  "Sources/RuntimeController.swift",
  "Sources/RuntimeDatabaseImportAuthority.swift",
  "Sources/RuntimeDatabaseImportController.swift",
  "Sources/RuntimeDatabaseImportSchema.swift",
  "Sources/RuntimeDatabaseSanitizer.swift",
  "Sources/RuntimeExternalPath.swift",
  "Sources/RuntimeGUI.swift",
  "Sources/RuntimeGUIDataProtection.swift",
  "Sources/RuntimeLanController.swift",
  "Sources/RuntimeLanDiagnostics.swift",
  "Sources/RuntimeLanModels.swift",
  "Sources/RuntimeLanQR.swift",
  "Sources/RuntimeLanStorage.swift",
  "Sources/RuntimeLanValidation.swift",
  "Sources/RuntimeLanView.swift",
  "Sources/RuntimeLaunchAgentController.swift",
  "Sources/RuntimeMaintenanceController.swift",
  "Sources/RuntimeMaintenanceModels.swift",
  "Sources/RuntimeMaintenanceRetention.swift",
  "Sources/RuntimeManagedRestoreController.swift",
  "Sources/RuntimeModels.swift",
  "Sources/RuntimePasswordKDF.swift",
  "Sources/RuntimePayloadValidationStaging.swift",
  "Sources/RuntimePortableArchive.swift",
  "Sources/RuntimePortableArchiveTesting.swift",
  "Sources/RuntimePhotoConsistency.swift",
  "Sources/RuntimePhotoConsistencyTesting.swift",
  "Sources/RuntimeReleaseLanRecovery.swift",
  "Sources/RuntimeStorage.swift",
  "Sources/RuntimeStorageTesting.swift",
  "Sources/RuntimeSetupValidation.swift",
  "Sources/RuntimeSupportBundle.swift",
  "Sources/RuntimeTestingImages.swift",
  "Sources/RuntimeTransferController.swift",
  "Sources/RuntimeTransferFileVersion.swift",
  "Sources/RuntimeTransferModels.swift",
  "Sources/RuntimeTransferOperations.swift",
  "Sources/RuntimeTransferPayloadValidation.swift",
  "Sources/RuntimeTransferPayloadValidationTesting.swift",
  "Sources/RuntimeTransferRecovery.swift",
  "Sources/RuntimeTransferRecoveryGateTesting.swift",
  "Sources/RuntimeUpgradeController.swift",
  "Sources/RuntimeUpgradeModels.swift",
  "Sources/StreamingRunner.swift",
  "Sources/main.swift",
  "build-app.mjs",
  "generate-manifest.mjs",
  "generate-manifest.test.mjs",
  "inspect-app.mjs",
  "no-repo-acceptance.mjs",
  "no-repo-commissioning.mjs",
  "no-repo-data-helpers.mjs",
  "no-repo-helpers.mjs",
  "no-repo-lan-acceptance.mjs",
  "no-repo-lan-maintenance-acceptance.mjs",
  "no-repo-maintenance-acceptance.mjs",
  "no-repo-transfer-acceptance.mjs",
  "real-container-acceptance.mjs",
  "real-container-lan-acceptance.mjs",
  "real-container-transfer-acceptance.mjs",
  "release-app.mjs",
  "release-app.test.mjs",
  "release-artifacts.mjs",
  "runtime-app-acceptance.mjs",
  "runtime-data-acceptance.mjs",
]);

const sourceFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "build" || entry.name === "dist") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)));
    else files.push(relative(kitRoot, absolute));
  }
  return files;
};

test("runtime kit source allowlist excludes generated apps, binaries, and private keys", async () => {
  assert.equal(await readFile(join(kitRoot, ".gitignore"), "utf8"), "/build/\n/dist/\n");
  assert.deepEqual((await sourceFiles(kitRoot)).sort(), [...sourceAllowlist].sort());

  const ignored = await execute(
    "/usr/bin/git",
    ["check-ignore", "tools/runtime-kit/build/private.pem", "tools/runtime-kit/dist/runtime.app"],
    { cwd: repositoryRoot },
  );
  assert.deepEqual(ignored.stdout.trim().split("\n"), [
    "tools/runtime-kit/build/private.pem",
    "tools/runtime-kit/dist/runtime.app",
  ]);

  const tracked = await execute("/usr/bin/git", ["ls-files", "tools/runtime-kit"], {
    cwd: repositoryRoot,
  });
  assert.doesNotMatch(
    tracked.stdout,
    /(?:^|\/)(?:build|dist)\/|\.(?:app|dylib|pem|p12|key)(?:\n|$)/u,
  );
});

test("runtime release transactions use one verified snapshot and one previous-manifest read", async () => {
  const controller = await readFile(
    join(kitRoot, "Sources", "RuntimeUpgradeController.swift"),
    "utf8",
  );
  assert.equal(controller.match(/let snapshot = try loadSnapshot\(\)/gu)?.length, 2);
  assert.equal(
    controller.match(/RuntimeStorage\.readPrivate\(paths\.previousManifest\)/gu)?.length,
    2,
  );
  assert.doesNotMatch(
    controller,
    /RuntimeManifestVerifier\.sha256\(\s*try RuntimeStorage\.readPrivate/u,
  );
  assert.match(controller, /_ = try validatedTransition\(prepared\)/u);
});
