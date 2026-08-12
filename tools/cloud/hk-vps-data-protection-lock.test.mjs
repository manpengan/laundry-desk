import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  DATA_PROTECTION_LOCK_FD,
  assertDataProtectionLockRecord,
  assertDataProtectionLockHeld,
  runDataProtectionLockProbe,
} from "./hk-vps-data-protection-lock.mjs";

const ordinary = (changes = {}) => ({
  dev: 10,
  gid: 0,
  ino: 20,
  mode: 0o100600,
  nlink: 1,
  uid: 0,
  isFile: () => true,
  isSymbolicLink: () => false,
  ...changes,
});

test("internal data-protection execution requires the inherited release-lock descriptor", async () => {
  let probed = null;
  await assertDataProtectionLockHeld({
    fstat: () => ordinary(),
    lstat: async () => ordinary(),
    pid: 42,
    readFdInfo: async () => "lock:\t1: FLOCK ADVISORY WRITE 42 00:44:20 0 EOF\n",
    runLockProbe: async (target) => {
      probed = target;
    },
  });
  assert.equal(probed.ino, ordinary().ino);
  assert.equal(DATA_PROTECTION_LOCK_FD, 3);
});

test("the inherited descriptor record must own one exclusive flock in this process", () => {
  assert.doesNotThrow(() =>
    assertDataProtectionLockRecord(
      "pos:\t0\nflags:\t0400000\nlock:\t1: FLOCK ADVISORY WRITE 42 00:44:20 0 EOF\n",
      { pid: 42, ino: 20 },
    ),
  );
  for (const source of [
    "pos:\t0\n",
    "lock:\t1: FLOCK ADVISORY WRITE 41 00:44:20 0 EOF\n",
    "lock:\t1: FLOCK ADVISORY READ 42 00:44:20 0 EOF\n",
    "lock:\t1: FLOCK ADVISORY WRITE 42 00:44:21 0 EOF\n",
  ]) {
    assert.throws(() => assertDataProtectionLockRecord(source, { pid: 42, ino: 20 }), {
      code: "CLOUD_DATA_LOCK_REQUIRED",
    });
  }
});

test("the independent probe uses descriptor-only flock syntax", async () => {
  let invocation = null;
  const child = new EventEmitter();
  await runDataProtectionLockProbe(ordinary(), {
    lstat: async () => ordinary(),
    lockPath: "/run/lock/laundry-desk-cloud-release.lock",
    open: async () => ({
      close: async () => undefined,
      fd: 17,
      stat: async () => ordinary(),
    }),
    spawn: (command, args, options) => {
      invocation = { args, command, options };
      queueMicrotask(() => child.emit("close", 73, null));
      return child;
    },
  });
  assert.deepEqual(invocation?.args, [
    "--exclusive",
    "--nonblock",
    "--conflict-exit-code",
    "73",
    String(DATA_PROTECTION_LOCK_FD),
  ]);
  assert.equal(invocation?.command, "/usr/bin/flock");
  assert.equal(invocation?.options.stdio[DATA_PROTECTION_LOCK_FD], 17);
});

test("forged lock-held execution fails on missing, replaced or writable lock authority", async () => {
  for (const target of [
    ordinary({ ino: 21 }),
    ordinary({ mode: 0o100622 }),
    ordinary({ uid: 501 }),
  ]) {
    await assert.rejects(
      () =>
        assertDataProtectionLockHeld({
          fstat: () => ordinary(),
          lstat: async () => target,
          runLockProbe: async () => undefined,
        }),
      { code: "CLOUD_DATA_LOCK_REQUIRED" },
    );
  }
});
