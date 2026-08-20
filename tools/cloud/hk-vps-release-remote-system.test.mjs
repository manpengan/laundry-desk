import assert from "node:assert/strict";
import test from "node:test";

import {
  DESK_PUBLIC_READINESS_POLICY,
  DESK_READINESS_POLICY,
} from "./hk-vps-release-readiness.mjs";
import { assertDeskHealth, restorePreviousCode } from "./hk-vps-release-remote-system.mjs";
import { LIVE_ROOT, releasePaths } from "./hk-vps-release-remote-support.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const READY = JSON.stringify({ ok: true, data: { status: "ready" } });

function result(stdout = "") {
  return Object.freeze({ code: 0, stderr: "", stdout });
}

function transientFailure(code = "CLOUD_RELEASE_LOOPBACK_HEALTH_FAILED") {
  return new Error(code);
}

function healthFixture({
  binding = "LISTEN 0 511 127.0.0.1:8787 0.0.0.0:*\n",
  failures = 0,
  loopback = READY,
  marker = EXPECTED,
  publicFailures = 0,
  publicHealth = READY,
  spaFailures = 0,
} = {}) {
  const events = [];
  let loopbackAttempts = 0;
  let publicAttempts = 0;
  let spaAttempts = 0;
  return {
    dependencies: {
      command: async () => {
        events.push("binding");
        return result(binding);
      },
      curl: async (url, label, signal, discard, maxTime, timeoutMs) => {
        events.push(`curl:${label}:${discard === true ? "discard" : "read"}`);
        if (label === "CLOUD_RELEASE_LOOPBACK_HEALTH") {
          assert.equal(maxTime, DESK_READINESS_POLICY.probeMaxTimeSeconds);
          assert.equal(timeoutMs, DESK_READINESS_POLICY.probeTimeoutMs);
          loopbackAttempts += 1;
          if (loopbackAttempts <= failures) throw transientFailure();
          return result(loopback);
        }
        if (label === "CLOUD_RELEASE_PUBLIC_HEALTH") {
          assert.equal(maxTime, DESK_PUBLIC_READINESS_POLICY.probeMaxTimeSeconds);
          assert.equal(timeoutMs, DESK_PUBLIC_READINESS_POLICY.probeTimeoutMs);
          publicAttempts += 1;
          if (publicAttempts <= publicFailures) {
            throw transientFailure("CLOUD_RELEASE_PUBLIC_HEALTH_FAILED");
          }
          return result(publicHealth);
        }
        assert.equal(url, "https://desk.manpengan.xyz/");
        assert.equal(maxTime, DESK_PUBLIC_READINESS_POLICY.probeMaxTimeSeconds);
        assert.equal(timeoutMs, DESK_PUBLIC_READINESS_POLICY.probeTimeoutMs);
        spaAttempts += 1;
        if (spaAttempts <= spaFailures) throw transientFailure("CLOUD_RELEASE_PUBLIC_SPA_FAILED");
        return result();
      },
      readReleaseMarker: async (path) => {
        events.push(`marker:${path}`);
        return Object.freeze({ environment: "cloud-test", git_sha: marker });
      },
      waitForReadiness: async (signal) => {
        events.push("wait");
        assert.equal(signal, undefined);
      },
    },
    events,
    loopbackAttempts: () => loopbackAttempts,
    publicAttempts: () => publicAttempts,
    spaAttempts: () => spaAttempts,
  };
}

test("desk health retries one transient loopback startup failure before strict gates", async () => {
  const fixture = healthFixture({ failures: 1 });
  await assertDeskHealth(EXPECTED, undefined, fixture.dependencies);
  assert.deepEqual(fixture.events, [
    "curl:CLOUD_RELEASE_LOOPBACK_HEALTH:read",
    "wait",
    "curl:CLOUD_RELEASE_LOOPBACK_HEALTH:read",
    "curl:CLOUD_RELEASE_PUBLIC_HEALTH:read",
    "curl:CLOUD_RELEASE_PUBLIC_SPA:discard",
    "binding",
    `marker:${LIVE_ROOT}`,
  ]);
});

test("desk health never retries a non-transient health contract error", async () => {
  const fixture = healthFixture({ loopback: '{"ok":true,"data":{"status":"starting"}}' });
  await assert.rejects(() => assertDeskHealth(EXPECTED, undefined, fixture.dependencies), {
    code: "CLOUD_RELEASE_HEALTH_INVALID",
  });
  assert.equal(fixture.loopbackAttempts(), 1);
  assert.equal(fixture.events.includes("wait"), false);
});

test("desk health keeps public envelope, loopback binding and marker fail closed", async () => {
  for (const [options, code] of [
    [{ publicHealth: "{}" }, "CLOUD_RELEASE_HEALTH_INVALID"],
    [{ binding: "LISTEN 0 511 0.0.0.0:8787 0.0.0.0:*\n" }, "CLOUD_RELEASE_DESK_BINDING_INVALID"],
    [{ marker: CANDIDATE }, "CLOUD_RELEASE_MARKER_MISMATCH"],
  ]) {
    const fixture = healthFixture(options);
    await assert.rejects(() => assertDeskHealth(EXPECTED, undefined, fixture.dependencies), {
      code,
    });
    assert.equal(fixture.loopbackAttempts(), 1);
    assert.equal(fixture.events.includes("wait"), false);
  }
});

test("desk readiness exhausts its bounded retry budget and fails closed", async () => {
  const fixture = healthFixture({ failures: Number.POSITIVE_INFINITY });
  await assert.rejects(() => assertDeskHealth(EXPECTED, undefined, fixture.dependencies), {
    code: "CLOUD_RELEASE_DESK_READINESS_TIMEOUT",
  });
  assert.equal(fixture.loopbackAttempts(), DESK_READINESS_POLICY.attempts);
  assert.equal(
    fixture.events.filter((event) => event === "wait").length,
    DESK_READINESS_POLICY.attempts - 1,
  );
});

test("desk readiness aborts during its wait without another health attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const operation = assertDeskHealth(EXPECTED, controller.signal, {
    curl: async () => {
      attempts += 1;
      throw transientFailure();
    },
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => operation, { code: "CLOUD_RELEASE_LOOPBACK_HEALTH_ABORTED" });
  assert.equal(attempts, 1);
});

test("public health retries a transient hairpin failure before strict gates", async () => {
  const fixture = healthFixture({ publicFailures: 2 });
  await assertDeskHealth(EXPECTED, undefined, fixture.dependencies);
  assert.equal(fixture.publicAttempts(), 3);
  assert.deepEqual(fixture.events, [
    "curl:CLOUD_RELEASE_LOOPBACK_HEALTH:read",
    "curl:CLOUD_RELEASE_PUBLIC_HEALTH:read",
    "wait",
    "curl:CLOUD_RELEASE_PUBLIC_HEALTH:read",
    "wait",
    "curl:CLOUD_RELEASE_PUBLIC_HEALTH:read",
    "curl:CLOUD_RELEASE_PUBLIC_SPA:discard",
    "binding",
    `marker:${LIVE_ROOT}`,
  ]);
});

test("public readiness exhausts its bounded budget and fails closed on its own code", async () => {
  const fixture = healthFixture({ publicFailures: Number.POSITIVE_INFINITY });
  await assert.rejects(() => assertDeskHealth(EXPECTED, undefined, fixture.dependencies), {
    code: "CLOUD_RELEASE_PUBLIC_READINESS_TIMEOUT",
  });
  assert.equal(fixture.publicAttempts(), DESK_PUBLIC_READINESS_POLICY.attempts);
  assert.equal(
    fixture.events.filter((event) => event === "wait").length,
    DESK_PUBLIC_READINESS_POLICY.attempts - 1,
  );
  assert.equal(fixture.spaAttempts(), 0);
});

test("public SPA retries transiently but a bad public envelope never retries", async () => {
  const retried = healthFixture({ spaFailures: 1 });
  await assertDeskHealth(EXPECTED, undefined, retried.dependencies);
  assert.equal(retried.spaAttempts(), 2);

  const invalid = healthFixture({ publicHealth: "{}" });
  await assert.rejects(() => assertDeskHealth(EXPECTED, undefined, invalid.dependencies), {
    code: "CLOUD_RELEASE_HEALTH_INVALID",
  });
  assert.equal(invalid.publicAttempts(), 1);
  assert.equal(invalid.events.includes("wait"), false);
});

test("public readiness aborts during its wait without another public attempt", async () => {
  const controller = new AbortController();
  let publicAttempts = 0;
  const operation = assertDeskHealth(EXPECTED, controller.signal, {
    curl: async (_url, label) => {
      if (label === "CLOUD_RELEASE_LOOPBACK_HEALTH") return result(READY);
      publicAttempts += 1;
      throw transientFailure("CLOUD_RELEASE_PUBLIC_HEALTH_FAILED");
    },
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => operation, { code: "CLOUD_RELEASE_PUBLIC_HEALTH_ABORTED" });
  assert.equal(publicAttempts, 1);
});

test("public SPA abort uses the SPA-specific stable code", async () => {
  const controller = new AbortController();
  let spaAttempts = 0;
  const operation = assertDeskHealth(EXPECTED, controller.signal, {
    command: async () => result("LISTEN 0 511 127.0.0.1:8787 0.0.0.0:*\n"),
    curl: async (_url, label) => {
      if (label !== "CLOUD_RELEASE_PUBLIC_SPA") return result(READY);
      spaAttempts += 1;
      throw transientFailure("CLOUD_RELEASE_PUBLIC_SPA_FAILED");
    },
    readReleaseMarker: async () => ({ git_sha: EXPECTED }),
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(() => operation, { code: "CLOUD_RELEASE_PUBLIC_SPA_ABORTED" });
  assert.equal(spaAttempts, 1);
});

test("rollback starts restored code before readiness retry and shared checks", async () => {
  const paths = releasePaths(CANDIDATE, EXPECTED);
  const health = healthFixture({ failures: 1 });
  const events = [];
  await restorePreviousCode(
    Object.freeze({
      candidate_sha: CANDIDATE,
      expected_sha: EXPECTED,
      failed_path: paths.failed,
      rollback_path: paths.rollback,
    }),
    {
      assertDeskHealth: async (sha, signal) => {
        events.push("health");
        await assertDeskHealth(sha, signal, health.dependencies);
      },
      assertSharedInfrastructure: async () => events.push("shared"),
      command: async () => events.push("stop"),
      pathExists: async () => true,
      readReleaseMarker: async () => ({ git_sha: EXPECTED }),
      startDesk: async () => events.push("start"),
    },
  );
  assert.deepEqual(events, ["stop", "start", "health", "shared"]);
  assert.equal(health.loopbackAttempts(), 2);
  assert.equal(health.events.filter((event) => event === "wait").length, 1);
});
