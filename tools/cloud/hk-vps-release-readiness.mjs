import { setTimeout as delay } from "node:timers/promises";

import { fail } from "./hk-vps-release-core.mjs";

// Loopback readiness only waits for the freshly restarted Desk process to bind and answer; the
// probe is cheap and local, so it can afford many short attempts.
export const DESK_READINESS_POLICY = Object.freeze({
  abortedCode: "CLOUD_RELEASE_LOOPBACK_HEALTH_ABORTED",
  attempts: 15,
  intervalMs: 1_000,
  probeMaxTimeSeconds: "2",
  probeTimeoutMs: 3_000,
  timeoutCode: "CLOUD_RELEASE_DESK_READINESS_TIMEOUT",
  transientCode: "CLOUD_RELEASE_LOOPBACK_HEALTH_FAILED",
});

// Public probes leave the host, resolve DNS, hairpin through NAT and terminate TLS at Caddy. Fewer,
// longer attempts keep that transient path bounded without retrying application-level contracts.
export const DESK_PUBLIC_READINESS_POLICY = Object.freeze({
  abortedCode: "CLOUD_RELEASE_PUBLIC_HEALTH_ABORTED",
  attempts: 5,
  intervalMs: 2_000,
  probeMaxTimeSeconds: "15",
  probeTimeoutMs: 20_000,
  timeoutCode: "CLOUD_RELEASE_PUBLIC_READINESS_TIMEOUT",
  transientCode: "CLOUD_RELEASE_PUBLIC_HEALTH_FAILED",
});

/** Re-point the bounded public policy at one public probe's stable transport failure codes. */
export function publicReadinessPolicy(label) {
  return Object.freeze({
    ...DESK_PUBLIC_READINESS_POLICY,
    abortedCode: `${label}_ABORTED`,
    transientCode: `${label}_FAILED`,
  });
}

const LOOPBACK_HEALTH_URL = "http://127.0.0.1:8787/health";
const LOOPBACK_HEALTH_LABEL = "CLOUD_RELEASE_LOOPBACK_HEALTH";

export async function probeLoopbackWithReadiness(executeCurl, signal, wait) {
  const policy = DESK_READINESS_POLICY;
  return await awaitDeskReadiness(
    () =>
      executeCurl(
        LOOPBACK_HEALTH_URL,
        LOOPBACK_HEALTH_LABEL,
        signal,
        false,
        policy.probeMaxTimeSeconds,
        policy.probeTimeoutMs,
      ),
    signal,
    { wait },
    policy,
  );
}

export async function probePublicWithReadiness(executeCurl, url, label, signal, discard, wait) {
  const policy = publicReadinessPolicy(label);
  return await awaitDeskReadiness(
    () =>
      executeCurl(url, label, signal, discard, policy.probeMaxTimeSeconds, policy.probeTimeoutMs),
    signal,
    { wait },
    policy,
  );
}

function failureCode(error) {
  if (!(error instanceof Error)) return undefined;
  return "code" in error ? error.code : error.message;
}

async function waitForReadiness(signal, policy) {
  try {
    await delay(policy.intervalMs, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) fail(policy.abortedCode, error);
    throw error;
  }
}

export async function awaitDeskReadiness(
  operation,
  signal,
  dependencies = {},
  policy = DESK_READINESS_POLICY,
) {
  const wait = dependencies.wait ?? waitForReadiness;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // Only this probe's transport failure is transient. Bad envelopes, markers and bindings
      // surface on the first attempt rather than consuming the readiness budget.
      if (failureCode(error) !== policy.transientCode) throw error;
      if (attempt === policy.attempts) fail(policy.timeoutCode, error);
      await wait(signal, policy);
    }
  }
  fail(policy.timeoutCode);
}
