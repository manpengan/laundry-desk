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
  archiveOrphanArtifact,
  archiveRetiredArtifact,
  archiveSupersededRollback,
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
  // Deliberately separate subcommands, not flags on --archive: retiring a tree the ledger never
  // claimed, and retiring a superseded committed rollback tree, are each a distinct separately
  // authorised decision and should read that way in shell history.
  for (const [flag, action] of [
    ["--archive-orphan", "archive-orphan"],
    ["--retire-superseded-rollback", "retire-superseded-rollback"],
  ]) {
    if (argv.length === 2 && argv[0] === flag && typeof argv[1] === "string") {
      return Object.freeze({ action, name: argv[1] });
    }
  }
  throw new CloudReleaseError("CLOUD_RELEASE_ARTIFACT_ARCHIVE_ARGS_INVALID");
}

const MOVERS = Object.freeze({
  archive: archiveRetiredArtifact,
  "archive-orphan": archiveOrphanArtifact,
  "retire-superseded-rollback": archiveSupersededRollback,
});

function describeBinding(action, result) {
  if (action === "archive-orphan") return `orphan_marker=${result.markerSha}`;
  if (action === "retire-superseded-rollback") {
    return `superseded=${result.candidates.join(",")} retired_marker=${result.markerSha}`;
  }
  return `candidates=${result.candidates.join(",")}`;
}

export async function main(argv, write) {
  const request = parseArguments(argv);
  if (request.action === "list") {
    const names = await listArchivableArtifacts();
    write(`CLOUD_RELEASE_ARTIFACT_ARCHIVE_LIST count=${names.length}\n`);
    for (const name of names) write(`  ${name}\n`);
    return;
  }
  const result = await MOVERS[request.action](request.name);
  write(
    `CLOUD_RELEASE_ARTIFACT_ARCHIVE_OK entries=${result.entries} bytes=${result.bytes} ` +
      `ino=${result.ino} ${describeBinding(request.action, result)} target=${result.target}\n`,
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
