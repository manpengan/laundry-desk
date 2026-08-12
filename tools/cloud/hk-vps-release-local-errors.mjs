import { CloudReleaseError } from "./hk-vps-release-identifiers.mjs";

const AMBIGUOUS_REMOTE_DEPLOY_CODES = new Set([
  "CLOUD_RELEASE_REMOTE_DEPLOY_ABORTED",
  "CLOUD_RELEASE_REMOTE_DEPLOY_FAILED",
  "CLOUD_RELEASE_REMOTE_DEPLOY_OUTPUT_TOO_LARGE",
  "CLOUD_RELEASE_REMOTE_DEPLOY_TIMEOUT",
]);

export function classifyRemoteDeployError(error) {
  if (error instanceof CloudReleaseError && AMBIGUOUS_REMOTE_DEPLOY_CODES.has(error.code)) {
    return new CloudReleaseError("CLOUD_RELEASE_RECOVERY_REQUIRED", { cause: error });
  }
  return error;
}
