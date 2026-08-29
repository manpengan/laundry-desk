import { createHash } from "node:crypto";
import { join } from "node:path";

import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";
import { fail, requireSha, requireToken } from "./hk-vps-release-core.mjs";

export const CONTROLLER_ROOT = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.controllerRoot;
export const CONTROLLER_MANIFEST_NAME = "files.json";
export const CONTROLLER_METADATA_NAME = "controller.json";
export const CONTROLLER_ENTRY = "tools/cloud/hk-vps-release-rollback-entry.mjs";
export const CONTROLLER_LAUNCHER = "tools/cloud/hk-vps-release-controller-launcher.mjs";

export function releaseControllerName(candidateSha, token) {
  const candidate = requireSha(candidateSha);
  const tokenDigest = createHash("sha256").update(requireToken(token)).digest("hex");
  return `${candidate}-${tokenDigest}.controller`;
}

export function releaseControllerPath(candidateSha, token) {
  return join(CONTROLLER_ROOT, releaseControllerName(candidateSha, token));
}

export function releaseControllerLauncherPath(candidateSha, token) {
  return join(releaseControllerPath(candidateSha, token), CONTROLLER_LAUNCHER);
}

export function assertControllerBinding(record) {
  if (
    record.controller_path !== releaseControllerPath(record.candidate_sha, record.token) ||
    typeof record.controller_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.controller_sha256) ||
    typeof record.archive_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.archive_sha256)
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_BINDING_INVALID");
  }
}
