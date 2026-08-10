import { setTimeout as delay } from "node:timers/promises";

import { fail } from "./hk-vps-release-core.mjs";

const TRANSIENT_FAILURE = "CLOUD_RELEASE_LOOPBACK_HEALTH_FAILED";

export const DESK_READINESS_POLICY = Object.freeze({
  attempts: 15,
  intervalMs: 1_000,
  probeMaxTimeSeconds: "2",
  probeTimeoutMs: 3_000,
});

function failureCode(error) {
  if (!(error instanceof Error)) return undefined;
  return "code" in error ? error.code : error.message;
}

async function waitForReadiness(signal) {
  try {
    await delay(DESK_READINESS_POLICY.intervalMs, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) fail("CLOUD_RELEASE_LOOPBACK_HEALTH_ABORTED", error);
    throw error;
  }
}

export async function awaitDeskReadiness(operation, signal, dependencies = {}) {
  const wait = dependencies.wait ?? waitForReadiness;
  for (let attempt = 1; attempt <= DESK_READINESS_POLICY.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (failureCode(error) !== TRANSIENT_FAILURE) throw error;
      if (attempt === DESK_READINESS_POLICY.attempts) {
        fail("CLOUD_RELEASE_DESK_READINESS_TIMEOUT", error);
      }
      await wait(signal);
    }
  }
  fail("CLOUD_RELEASE_DESK_READINESS_TIMEOUT");
}
