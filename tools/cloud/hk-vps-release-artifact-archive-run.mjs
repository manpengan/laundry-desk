// Host-side entry point for the retired-artifact archive. Runs as root ON hk-vps, from the
// deployed tree at /opt/laundry-desk/tools/cloud/. It is deliberately not reachable over HTTP and
// takes no secrets: the whole operation is one guarded, same-filesystem, reversible rename.
//
//   node /opt/laundry-desk/tools/cloud/hk-vps-release-artifact-archive-run.mjs --list
//   node /opt/laundry-desk/tools/cloud/hk-vps-release-artifact-archive-run.mjs --archive <name>
//
// `--archive` refuses any artifact that history does not prove is rolled back and
// non-authoritative, so the live release's rollback tree can never be moved by mistake.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CloudReleaseError } from "./hk-vps-release-identifiers.mjs";
import {
  archiveRetiredArtifact,
  listArchivableArtifacts,
} from "./hk-vps-release-artifact-archive.mjs";

function safeErrorCode(error) {
  if (error instanceof CloudReleaseError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)) {
    return error.message;
  }
  return "CLOUD_RELEASE_ARTIFACT_ARCHIVE_FAILED";
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--list") return Object.freeze({ action: "list" });
  if (argv.length === 2 && argv[0] === "--archive" && typeof argv[1] === "string") {
    return Object.freeze({ action: "archive", name: argv[1] });
  }
  throw new CloudReleaseError("CLOUD_RELEASE_ARTIFACT_ARCHIVE_ARGS_INVALID");
}

export async function main(argv, write) {
  const request = parseArguments(argv);
  if (request.action === "list") {
    const names = await listArchivableArtifacts();
    write(`CLOUD_RELEASE_ARTIFACT_ARCHIVE_LIST count=${names.length}\n`);
    for (const name of names) write(`  ${name}\n`);
    return;
  }
  const result = await archiveRetiredArtifact(request.name);
  write(
    `CLOUD_RELEASE_ARTIFACT_ARCHIVE_OK entries=${result.entries} bytes=${result.bytes} ` +
      `ino=${result.ino} target=${result.target}\n`,
  );
}

export function isDirectEntrypoint(entry, moduleUrl) {
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), (line) => process.stdout.write(line)).catch((error) => {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
