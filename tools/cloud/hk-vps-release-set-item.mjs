import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import { validateControllerDirectory } from "./hk-vps-release-controller-launcher.mjs";
import { fail, sha256File } from "./hk-vps-release-core.mjs";
import { backupManifestPath } from "./hk-vps-release-remote-support.mjs";

const CODE = "CLOUD_RELEASE_SET_ARCHIVE_INVALID";
const DIGEST = /^[0-9a-f]{64}$/u;

function use(dependencies, name, fallback) {
  return dependencies[name] ?? fallback;
}

function missing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

export function releaseHistoryDigest(record) {
  return createHash("sha256")
    .update(`${JSON.stringify(record)}\n`, "utf8")
    .digest("hex");
}

export function releaseSetItemSpecifications(entry, location) {
  const { record } = entry;
  const specifications = [
    Object.freeze({
      digest: record.controller_sha256,
      folder: "controller",
      kind: "controller",
      source: join(location.controllerRoot, basename(record.controller_path)),
      type: "directory",
    }),
  ];
  if (record.backup_path !== null) {
    const manifest = backupManifestPath(record.backup_path);
    specifications.push(
      Object.freeze({
        digest: record.backup_sha256,
        folder: "backups",
        kind: "backup",
        source: join(location.backupRoot, basename(record.backup_path)),
        type: "file",
      }),
      Object.freeze({
        digest: null,
        folder: "backups",
        kind: "backup_manifest",
        source: join(location.backupRoot, basename(manifest)),
        type: "file",
      }),
    );
  }
  if (record.verification_evidence_path !== null) {
    specifications.push(
      Object.freeze({
        digest: record.verification_evidence_sha256,
        folder: "evidence",
        kind: "evidence",
        source: join(location.stateRoot, basename(record.verification_evidence_path)),
        type: "file",
      }),
    );
  }
  specifications.push(
    Object.freeze({
      digest: releaseHistoryDigest(record),
      folder: "history",
      kind: "history",
      source: join(location.historyRoot, entry.name),
      type: "file",
    }),
  );
  return Object.freeze(
    specifications.map((specification) =>
      Object.freeze({
        ...specification,
        target: join(location.directory, specification.folder, basename(specification.source)),
      }),
    ),
  );
}

async function assertAbsent(path, dependencies) {
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => {
    if (missing(error)) return null;
    return fail(CODE, error);
  });
  if (metadata !== null) fail(CODE);
}

export async function captureReleaseSetItem(
  specification,
  archiveDevice,
  record,
  dependencies = {},
) {
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(specification.source).catch((error) => fail(CODE, error));
  const expectedMode = specification.type === "directory" ? 0o700 : 0o600;
  if (
    metadata.isSymbolicLink() ||
    (specification.type === "directory" ? !metadata.isDirectory() : !metadata.isFile()) ||
    metadata.uid !== (dependencies.uid ?? 0) ||
    metadata.gid !== (dependencies.gid ?? 0) ||
    (metadata.mode & 0o7777) !== expectedMode ||
    (specification.type === "file" && metadata.nlink !== 1) ||
    metadata.dev !== archiveDevice ||
    (await use(dependencies, "realpath", realpath)(specification.source).catch(() => null)) !==
      specification.source
  ) {
    fail(CODE);
  }
  await assertAbsent(specification.target, dependencies);
  let digest;
  if (specification.type === "directory") {
    const controller = await use(
      dependencies,
      "validateController",
      validateControllerDirectory,
    )(specification.source, { gid: dependencies.gid ?? 0, uid: dependencies.uid ?? 0 });
    if (
      controller.metadata.archive_sha256 !== record.archive_sha256 ||
      controller.metadata.candidate_sha !== record.candidate_sha ||
      controller.metadata.expected_sha !== record.expected_sha ||
      controller.metadata.migration_head !== record.migration_head
    ) {
      fail(CODE);
    }
    digest = controller.digest;
  } else {
    digest = await use(dependencies, "sha256File", sha256File)(specification.source);
  }
  if (!DIGEST.test(digest) || (specification.digest !== null && digest !== specification.digest)) {
    fail(CODE);
  }
  return Object.freeze({
    kind: specification.kind,
    type: specification.type,
    source: specification.source,
    target: specification.target,
    sha256: digest,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o7777,
    size: metadata.size,
  });
}

export async function verifyReleaseSetItem(item, record, path, dependencies = {}) {
  const metadata = await use(
    dependencies,
    "lstat",
    lstat,
  )(path).catch((error) => fail(CODE, error));
  if (
    metadata.isSymbolicLink() ||
    (item.type === "directory" ? !metadata.isDirectory() : !metadata.isFile()) ||
    String(metadata.dev) !== item.dev ||
    String(metadata.ino) !== item.ino ||
    metadata.uid !== item.uid ||
    metadata.gid !== item.gid ||
    (metadata.mode & 0o7777) !== item.mode ||
    metadata.size !== item.size ||
    (item.type === "file" && metadata.nlink !== 1) ||
    (await use(dependencies, "realpath", realpath)(path).catch(() => null)) !== path
  ) {
    fail(CODE);
  }
  let digest;
  if (item.type === "directory") {
    const controller = await use(
      dependencies,
      "validateController",
      validateControllerDirectory,
    )(path, { gid: item.gid, uid: item.uid });
    if (
      controller.metadata.archive_sha256 !== record.archive_sha256 ||
      controller.metadata.candidate_sha !== record.candidate_sha ||
      controller.metadata.expected_sha !== record.expected_sha ||
      controller.metadata.migration_head !== record.migration_head
    ) {
      fail(CODE);
    }
    digest = controller.digest;
  } else {
    digest = await use(dependencies, "sha256File", sha256File)(path);
  }
  if (digest !== item.sha256) fail(CODE);
}
