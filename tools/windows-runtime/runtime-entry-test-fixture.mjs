import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalManifest,
  digest,
  MANIFEST_NAME,
  REQUIRED_FILES,
  BACKUP_FILES,
} from "./companion-contract.mjs";
import { inventory } from "./companion-files.mjs";
import { COMPANION_SOURCES } from "./companion-sources.mjs";

export const SOURCE_SHA = "a".repeat(40);
export const SYNTHETIC_LAUNCHER = `param([string]$Action,[string]$Payload,[string]$ManifestDigest,[string]$BackupId,[string]$ConfirmationDigest)
@{ status='running'; assurance='development_only'; action=$Action; manifest_sha256=$ManifestDigest;
   backup_id=$BackupId; confirmation=$ConfirmationDigest; node_options=$env:NODE_OPTIONS;
   node_path=$env:NODE_PATH; policy=$env:PSExecutionPolicyPreference; path=$env:PATH } | ConvertTo-Json -Compress
`;

function syntheticPe() {
  // Structural package fixture only. Tests never execute these synthetic bytes.
  const bytes = Buffer.alloc(90);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

export async function runtimeEntryFixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ld-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = join(root, "source");
  await mkdir(payload);
  for (const path of [
    ...new Set([...REQUIRED_FILES, ...BACKUP_FILES, "migrations/0001_initial.sql"]),
  ]) {
    await mkdir(dirname(join(payload, path)), { recursive: true });
    await writeFile(
      join(payload, path),
      path === "scripts/lifecycle-launch.ps1"
        ? SYNTHETIC_LAUNCHER
        : path.endsWith(".exe")
          ? syntheticPe()
          : path.endsWith(".exe.sha256")
            ? `${digest(syntheticPe())}\n`
            : "synthetic fixture\n",
    );
  }
  const manifest = {
    schema: "laundry.windows.runtime-payload",
    version: 1,
    assurance: "development_only",
    platform: "win32-x64",
    source_git_sha: SOURCE_SHA,
    runtime_release: "0.1.0-win-dev",
    sources: COMPANION_SOURCES,
    migration_head: "0001_initial.sql",
    migrations_sha256: "b".repeat(64),
    files: (await inventory(payload)).files,
  };
  const bytes = canonicalManifest(manifest);
  await writeFile(join(payload, MANIFEST_NAME), bytes);
  return Object.freeze({
    root,
    payload,
    output: join(root, "operator"),
    manifest,
    manifestSha: digest(bytes),
    sourceSha: SOURCE_SHA,
  });
}
