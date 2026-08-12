import { spawn } from "node:child_process";
import { constants, fstatSync } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";

import { REMOTE_RELEASE_LOCK, fail } from "./hk-vps-release-core.mjs";

export const DATA_PROTECTION_LOCK_FD = 3;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertDataProtectionLockRecord(source, expected) {
  if (typeof source !== "string" || source.length > 4_096 || source.includes("\0")) {
    fail("CLOUD_DATA_LOCK_REQUIRED");
  }
  const lockLines = source.split("\n").filter((line) => line.startsWith("lock:"));
  if (lockLines.length !== 1) fail("CLOUD_DATA_LOCK_REQUIRED");
  const fields = lockLines[0].trim().split(/\s+/u);
  if (
    fields.length !== 9 ||
    fields[0] !== "lock:" ||
    !/^\d+:$/u.test(fields[1]) ||
    fields[2] !== "FLOCK" ||
    fields[3] !== "ADVISORY" ||
    fields[4] !== "WRITE" ||
    fields[5] !== String(expected.pid) ||
    !fields[6].endsWith(`:${expected.ino}`) ||
    fields[7] !== "0" ||
    fields[8] !== "EOF"
  ) {
    fail("CLOUD_DATA_LOCK_REQUIRED");
  }
}

async function spawnIndependentProbe(handle, dependencies) {
  const spawnProcess = dependencies.spawn ?? spawn;
  await new Promise((resolveProbe, rejectProbe) => {
    const child = spawnProcess(
      "/usr/bin/flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "73",
        String(DATA_PROTECTION_LOCK_FD),
        "/usr/bin/true",
      ],
      {
        cwd: "/",
        env: Object.freeze({
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        }),
        shell: false,
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      },
    );
    child.once("error", rejectProbe);
    child.once("close", (code, signal) => {
      if (code === 73 && signal === null) resolveProbe();
      else rejectProbe(new Error("lock probe failed"));
    });
  });
}

export async function runDataProtectionLockProbe(expected, dependencies = {}) {
  const lockPath = dependencies.lockPath ?? REMOTE_RELEASE_LOCK;
  const handle = await (dependencies.open ?? open)(
    lockPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  let failure;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(opened, expected)) {
      throw new Error("lock probe identity mismatch");
    }
    await spawnIndependentProbe(handle, dependencies);
    const rebound = await (dependencies.lstat ?? lstat)(lockPath);
    if (!rebound.isFile() || rebound.isSymbolicLink() || !sameFile(rebound, expected)) {
      throw new Error("lock probe path changed");
    }
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

export async function assertDataProtectionLockHeld(dependencies = {}) {
  const fd = dependencies.fd ?? DATA_PROTECTION_LOCK_FD;
  const lockPath = dependencies.lockPath ?? REMOTE_RELEASE_LOCK;
  const identity = dependencies.identity ?? Object.freeze({ uid: 0, gid: 0 });
  let inherited;
  let target;
  try {
    inherited = (dependencies.fstat ?? fstatSync)(fd);
    target = await (dependencies.lstat ?? lstat)(lockPath);
  } catch (error) {
    fail("CLOUD_DATA_LOCK_REQUIRED", error);
  }
  if (
    !Number.isSafeInteger(fd) ||
    fd !== DATA_PROTECTION_LOCK_FD ||
    !inherited.isFile() ||
    !target.isFile() ||
    target.isSymbolicLink() ||
    target.uid !== identity.uid ||
    target.gid !== identity.gid ||
    target.nlink !== 1 ||
    (target.mode & 0o022) !== 0 ||
    !sameFile(inherited, target)
  ) {
    fail("CLOUD_DATA_LOCK_REQUIRED");
  }
  try {
    const fdInfo = await (dependencies.readFdInfo ?? readFile)(
      dependencies.fdInfoPath ?? `/proc/self/fdinfo/${fd}`,
      "utf8",
    );
    assertDataProtectionLockRecord(fdInfo, {
      ino: inherited.ino,
      pid: dependencies.pid ?? process.pid,
    });
    await (dependencies.runLockProbe ?? runDataProtectionLockProbe)(target, {
      ...dependencies,
      lockPath,
    });
  } catch (error) {
    fail("CLOUD_DATA_LOCK_REQUIRED", error);
  }
}
