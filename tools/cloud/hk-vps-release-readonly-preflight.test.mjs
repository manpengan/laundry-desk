import assert from "node:assert/strict";
import test from "node:test";

import { CloudReleaseError, REMOTE_RELEASE_LOCK } from "./hk-vps-release-core.mjs";
import { MAX_RETAINED_RELEASES, MINIMUM_RELEASE_FREE_BYTES } from "./hk-vps-release-host-guard.mjs";
import {
  readReadonlyReleaseSnapshot,
  requireReadonlyReleaseSnapshot,
} from "./hk-vps-release-readonly-preflight.mjs";
import { RELEASE_ENVIRONMENT } from "./hk-vps-release-remote-support.mjs";
import {
  lockedReleaseSetArguments,
  main,
  parseReleaseSetArguments,
  releaseSetArguments,
} from "./hk-vps-release-set-archive-run.mjs";

const LIVE = "9".repeat(40);
const TOKEN = "sensitive-release-token";

function activeEntries(count, { backups = count, evidence = 0 } = {}) {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        record: Object.freeze({
          backup_path: index < backups ? `/private/${TOKEN}/backup-${index}` : null,
          controller_path: `/private/${TOKEN}/controller-${index}`,
          verification_evidence_path:
            index < evidence ? `/private/${TOKEN}/evidence-${index}` : null,
        }),
      }),
    ),
  );
}

function runnerFixture(options = {}) {
  const history = options.history ?? 7;
  const output = [];
  const events = [];
  const mutations = [];
  const dependencies = {
    ...(options.preflightError === undefined
      ? {}
      : {
          assertReadonlyReleasePreflight: async () => {
            events.push("preflight-assert");
            throw options.preflightError;
          },
        }),
    assertActiveReleaseSetIntegrity: async () => {
      events.push("active-integrity");
      return Object.hasOwn(options, "activeResult")
        ? options.activeResult
        : activeEntries(history, {
            backups: options.backups ?? history,
            evidence: options.evidence ?? 3,
          });
    },
    assertLockHeld: async () => {
      events.push("lock");
      if (options.lockError !== undefined) throw options.lockError;
    },
    mkdir: async () => mutations.push("mkdir"),
    processUid: options.processUid ?? 0,
    readReleaseHostSnapshot: async () => {
      events.push("host");
      return (
        options.hostResult ?? {
          historyActive: history,
          optAvailableBytes: options.optAvailableBytes ?? MINIMUM_RELEASE_FREE_BYTES,
          optResident: options.optResident ?? 5,
          postgresqlAvailableBytes: options.postgresqlAvailableBytes ?? MINIMUM_RELEASE_FREE_BYTES,
        }
      );
    },
    readReleaseMarker: async () => {
      events.push("marker");
      return options.markerResult ?? { environment: RELEASE_ENVIRONMENT, git_sha: LIVE };
    },
    rename: async () => mutations.push("rename"),
    rm: async () => mutations.push("rm"),
    stdout: { write: (value) => output.push(value) },
    transitionExists: async () => {
      events.push("transition");
      if (options.transitionError !== undefined) throw options.transitionError;
      return options.transition;
    },
    writeFile: async () => mutations.push("writeFile"),
  };
  return Object.freeze({ dependencies, events, mutations, output });
}

async function runLockedAction(action, options = {}) {
  const fixture = runnerFixture({ transition: false, ...options });
  const code = await main(["--lock-held", action], fixture.dependencies);
  return Object.freeze({ ...fixture, code, text: fixture.output.join("") });
}

test("CLI accepts only argument-free inventory and preflight actions under the shared lock", () => {
  for (const action of ["inventory", "preflight"]) {
    const parsed = parseReleaseSetArguments([action]);
    assert.deepEqual(parsed, { action, identity: null });
    assert.deepEqual(releaseSetArguments(parsed), [action]);
    const script = "/opt/laundry-desk/tools/cloud/hk-vps-release-set-archive-run.mjs";
    const locked = lockedReleaseSetArguments(script, parsed);
    assert.deepEqual(locked.slice(0, 9), [
      "--no-fork",
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      REMOTE_RELEASE_LOCK,
      "/opt/nodejs/bin/node",
      script,
      "--lock-held",
    ]);
    assert.equal(locked.at(-1), action);
  }
  for (const arguments_ of [["inventory", "extra"], ["preflight", "extra"], ["--lock-held"]]) {
    assert.throws(() => parseReleaseSetArguments(arguments_), {
      code: "CLOUD_RELEASE_SET_ARGS_INVALID",
    });
  }
});

test("root, inherited lock and an explicitly stable transition precede all inventory reads", async () => {
  const notRoot = runnerFixture({ processUid: 501, transition: false });
  await assert.rejects(() => main(["--lock-held", "inventory"], notRoot.dependencies), {
    code: "CLOUD_RELEASE_SET_ROOT_REQUIRED",
  });
  assert.deepEqual(notRoot.events, []);
  assert.deepEqual(notRoot.output, []);

  const lockFailure = runnerFixture({
    lockError: new Error("no inherited lock"),
    transition: false,
  });
  await assert.rejects(() => main(["--lock-held", "inventory"], lockFailure.dependencies), {
    code: "CLOUD_DATA_LOCK_REQUIRED",
  });
  assert.deepEqual(lockFailure.events, ["lock"]);
  assert.deepEqual(lockFailure.output, []);

  for (const transition of [true, undefined]) {
    const active = runnerFixture({ transition });
    await assert.rejects(() => main(["--lock-held", "inventory"], active.dependencies), {
      code: "CLOUD_RELEASE_SET_TRANSITION_ACTIVE",
    });
    assert.deepEqual(active.events, ["lock", "transition"]);
    assert.deepEqual(active.output, []);
  }

  for (const transitionError of [
    new Error("transition probe failed"),
    new CloudReleaseError("CLOUD_RELEASE_CAPACITY_INVALID"),
  ]) {
    const failedProbe = runnerFixture({ transitionError });
    await assert.rejects(() => main(["--lock-held", "inventory"], failedProbe.dependencies), {
      code: "CLOUD_RELEASE_SET_TRANSITION_ACTIVE",
    });
    assert.deepEqual(failedProbe.events, ["lock", "transition"]);
    assert.deepEqual(failedProbe.output, []);
  }
});

test("inventory and preflight emit one fixed secret-free line from the same strict snapshot", async () => {
  const inventory = await runLockedAction("inventory");
  assert.equal(inventory.code, 0);
  assert.equal(
    inventory.text,
    `CLOUD_RELEASE_INVENTORY_OK phase=stable live_sha=${LIVE} ` +
      "opt_resident=5 opt_reserved=2 opt_prepare_peak=7 history_active=7 " +
      "controller_active=7 backup_sets_active=7 evidence_active=3 " +
      `opt_available_bytes=${MINIMUM_RELEASE_FREE_BYTES} ` +
      `postgresql_available_bytes=${MINIMUM_RELEASE_FREE_BYTES} ` +
      "artifact_room=true history_room=true backup_room=true\n",
  );
  assert.equal(inventory.text.includes(TOKEN), false);
  assert.deepEqual(inventory.events, ["lock", "transition", "active-integrity", "marker", "host"]);

  const preflight = await runLockedAction("preflight");
  assert.equal(preflight.text, inventory.text.replace("INVENTORY", "PREFLIGHT"));
});

test("inventory reports full slots, while preflight enforces stable 5/6 and 7/8 boundaries", async () => {
  await assert.doesNotReject(() => runLockedAction("preflight", { optResident: 5 }));
  for (const [options, code] of [
    [{ optResident: 6 }, "CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT"],
    [{ backups: 0, history: 8 }, "CLOUD_RELEASE_HISTORY_RETENTION_LIMIT"],
  ]) {
    const fixture = runnerFixture({ transition: false, ...options });
    await assert.rejects(() => main(["--lock-held", "preflight"], fixture.dependencies), { code });
    assert.deepEqual(fixture.output, []);
  }

  const sevenBackups = await runLockedAction("inventory", { backups: 7, history: 7 });
  assert.match(sevenBackups.text, /history_room=true backup_room=true\n$/u);
  const eightBackups = await runLockedAction("inventory", { backups: 8, history: 8 });
  assert.match(eightBackups.text, /history_room=false backup_room=false\n$/u);

  const full = await runLockedAction("inventory", {
    backups: MAX_RETAINED_RELEASES,
    history: MAX_RETAINED_RELEASES,
    optResident: MAX_RETAINED_RELEASES,
  });
  assert.match(full.text, /artifact_room=false history_room=false backup_room=false\n$/u);
});

test("capacity is reported at inventory time and enforced only by preflight", async () => {
  await assert.doesNotReject(() =>
    runLockedAction("preflight", {
      optAvailableBytes: MINIMUM_RELEASE_FREE_BYTES,
      postgresqlAvailableBytes: MINIMUM_RELEASE_FREE_BYTES,
    }),
  );
  const inventory = await runLockedAction("inventory", {
    optAvailableBytes: MINIMUM_RELEASE_FREE_BYTES - 1,
  });
  assert.match(inventory.text, /opt_available_bytes=8589934591/u);

  const low = runnerFixture({
    optAvailableBytes: MINIMUM_RELEASE_FREE_BYTES - 1,
    transition: false,
  });
  await assert.rejects(() => main(["--lock-held", "preflight"], low.dependencies), {
    code: "CLOUD_RELEASE_CAPACITY_LOW",
  });
  assert.deepEqual(low.output, []);
});

test("runner awaits an asynchronous preflight rejection before writing success", async () => {
  const fixture = runnerFixture({
    preflightError: new CloudReleaseError("CLOUD_RELEASE_CAPACITY_LOW"),
    transition: false,
  });
  await assert.rejects(() => main(["--lock-held", "preflight"], fixture.dependencies), {
    code: "CLOUD_RELEASE_CAPACITY_LOW",
  });
  assert.equal(fixture.events.at(-1), "preflight-assert");
  assert.deepEqual(fixture.output, []);
});

test("unknown collaborator results fail closed without stdout", async () => {
  for (const [options, code] of [
    [{ activeResult: undefined }, "CLOUD_RELEASE_SET_ARCHIVE_INVALID"],
    [{ hostResult: { historyActive: 0 } }, "CLOUD_RELEASE_CAPACITY_INVALID"],
    [{ markerResult: { git_sha: LIVE } }, "CLOUD_RELEASE_MARKER_INVALID"],
  ]) {
    const fixture = runnerFixture({ transition: false, ...options });
    await assert.rejects(() => main(["--lock-held", "inventory"], fixture.dependencies), { code });
    assert.deepEqual(fixture.output, []);
  }
});

test("repeated reads are immutable, identical and never invoke mutation dependencies", async () => {
  const fixture = runnerFixture({ transition: false });
  const first = await readReadonlyReleaseSnapshot(undefined, fixture.dependencies);
  const second = await readReadonlyReleaseSnapshot(undefined, fixture.dependencies);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(fixture.mutations, []);
  assert.equal(requireReadonlyReleaseSnapshot(first), first);
});
