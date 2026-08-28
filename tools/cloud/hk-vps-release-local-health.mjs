import {
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  requireCloudEnvironmentProfile,
} from "./cloud-environment-profile.mjs";
import { fail } from "./hk-vps-release-identifiers.mjs";

const CURL = "/usr/bin/curl";
const HEALTH_ENVELOPE = Object.freeze({ ok: true, data: Object.freeze({ status: "ready" }) });

async function curl(context, execute, url, label) {
  return await execute(
    context,
    CURL,
    ["--fail", "--silent", "--show-error", "--max-time", "15", url],
    label,
  );
}

export async function assertProfileExternalHealth(context, execute) {
  if (typeof execute !== "function") fail("CLOUD_RELEASE_ORCHESTRATOR_INVALID");
  const profile = requireCloudEnvironmentProfile(
    context?.profile ?? DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  );
  const publicOrigin = profile.endpoints.deskPublicOrigin;
  const health = await curl(
    context,
    execute,
    `${publicOrigin}/health`,
    "CLOUD_RELEASE_EXTERNAL_HEALTH",
  );
  let parsed;
  try {
    parsed = JSON.parse(health.stdout);
  } catch (error) {
    fail("CLOUD_RELEASE_EXTERNAL_HEALTH_INVALID", error);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(HEALTH_ENVELOPE)) {
    fail("CLOUD_RELEASE_EXTERNAL_HEALTH_INVALID");
  }
  await execute(
    context,
    CURL,
    [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "15",
      "--output",
      "/dev/null",
      publicOrigin,
    ],
    "CLOUD_RELEASE_EXTERNAL_SPA",
  );
  const kb = await curl(
    context,
    execute,
    profile.endpoints.kbPublicHealthUrl,
    "CLOUD_RELEASE_EXTERNAL_KB",
  );
  if (kb.stdout.trim() !== "ok") fail("CLOUD_RELEASE_EXTERNAL_KB_INVALID");
}
