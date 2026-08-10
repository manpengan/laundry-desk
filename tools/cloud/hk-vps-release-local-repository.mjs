import { realpath } from "node:fs/promises";

import { assertRequiredChecks, fail } from "./hk-vps-release-core.mjs";

export const CANONICAL_ORIGIN_URL = "git@github.com:manpengan/laundry-desk.git";

const REPOSITORY = "manpengan/laundry-desk";
const GIT = "/usr/bin/git";
const GH = "/opt/homebrew/bin/gh";

function requireCanonicalOrigin(source) {
  if (source !== `${CANONICAL_ORIGIN_URL}\n`) fail("CLOUD_RELEASE_GIT_ORIGIN_INVALID");
}

function parseCheckRuns(source) {
  try {
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed.check_runs)) fail("CLOUD_RELEASE_CI_INVALID");
    return parsed.check_runs;
  } catch (error) {
    if (error?.code === "CLOUD_RELEASE_CI_INVALID") throw error;
    fail("CLOUD_RELEASE_CI_INVALID", error);
  }
}

export async function assertRepositoryCandidate(context, candidateSha, execute, dependencies = {}) {
  const origin = await execute(
    context,
    GIT,
    ["remote", "get-url", "origin"],
    "CLOUD_RELEASE_GIT_ORIGIN",
  );
  requireCanonicalOrigin(origin.stdout);
  await execute(
    context,
    GIT,
    ["fetch", "--quiet", "origin", "main"],
    "CLOUD_RELEASE_GIT_FETCH",
    5 * 60_000,
  );
  const [root, status, branch, head, remote] = await Promise.all([
    execute(context, GIT, ["rev-parse", "--show-toplevel"], "CLOUD_RELEASE_GIT_ROOT"),
    execute(
      context,
      GIT,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "CLOUD_RELEASE_GIT_STATUS",
    ),
    execute(context, GIT, ["symbolic-ref", "--short", "HEAD"], "CLOUD_RELEASE_GIT_BRANCH"),
    execute(context, GIT, ["rev-parse", "HEAD"], "CLOUD_RELEASE_GIT_HEAD"),
    execute(context, GIT, ["rev-parse", "origin/main"], "CLOUD_RELEASE_GIT_REMOTE"),
  ]);
  const canonicalRoot = await (dependencies.realpath ?? realpath)(root.stdout.trim()).catch(
    () => null,
  );
  if (
    canonicalRoot !== context.cwd ||
    status.stdout !== "" ||
    branch.stdout !== "main\n" ||
    head.stdout !== `${candidateSha}\n` ||
    remote.stdout !== `${candidateSha}\n`
  ) {
    fail("CLOUD_RELEASE_CANDIDATE_NOT_EXACT_MAIN");
  }
  const checks = await execute(
    context,
    GH,
    [
      "api",
      "--hostname",
      "github.com",
      `repos/${REPOSITORY}/commits/${candidateSha}/check-runs?per_page=100`,
    ],
    "CLOUD_RELEASE_GITHUB_CHECKS",
  );
  assertRequiredChecks(parseCheckRuns(checks.stdout), candidateSha);
}
