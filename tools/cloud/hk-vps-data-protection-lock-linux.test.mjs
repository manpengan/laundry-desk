import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PROBE_SOURCE = String.raw`
const module = await import(process.env.TEST_LOCK_MODULE_URL);
try {
  await module.assertDataProtectionLockHeld({
    lockPath: process.env.TEST_LOCK_PATH,
    identity: {
      uid: Number(process.env.TEST_LOCK_UID),
      gid: Number(process.env.TEST_LOCK_GID),
    },
  });
  process.exitCode = 0;
} catch (error) {
  process.exitCode = error?.code === "CLOUD_DATA_LOCK_REQUIRED" ? 73 : 74;
}
`;

function environment(lockPath) {
  return Object.freeze({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    TEST_LOCK_GID: String(process.getgid()),
    TEST_LOCK_MODULE_URL: new URL("./hk-vps-data-protection-lock.mjs", import.meta.url).href,
    TEST_LOCK_PATH: lockPath,
    TEST_LOCK_UID: String(process.getuid()),
  });
}

function runProbe(lockPath, descriptor) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", PROBE_SOURCE], {
    cwd: "/",
    env: environment(lockPath),
    shell: false,
    stdio: ["ignore", "ignore", "ignore", descriptor],
  });
}

test(
  "Linux proves the inherited exact descriptor owns the release flock",
  { skip: process.platform !== "linux" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-data-lock-"));
    context.after(() => rm(root, { force: true, recursive: true }));
    const lockPath = join(root, "release.lock");
    const otherPath = join(root, "other.lock");
    await writeFile(lockPath, "", { mode: 0o600 });
    await writeFile(otherPath, "", { mode: 0o600 });

    const locked = spawnSync(
      "/usr/bin/flock",
      [
        "--no-fork",
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "72",
        lockPath,
        process.execPath,
        "--input-type=module",
        "--eval",
        PROBE_SOURCE,
      ],
      {
        cwd: "/",
        env: environment(lockPath),
        shell: false,
        stdio: "ignore",
      },
    );
    assert.equal(locked.signal, null);
    assert.equal(locked.status, 0);

    const exactUnlocked = await open(lockPath, "r");
    try {
      const result = runProbe(lockPath, exactUnlocked.fd);
      assert.equal(result.signal, null);
      assert.equal(result.status, 73);
    } finally {
      await exactUnlocked.close();
    }

    const wrong = await open(otherPath, "r");
    try {
      const result = runProbe(lockPath, wrong.fd);
      assert.equal(result.signal, null);
      assert.equal(result.status, 73);
    } finally {
      await wrong.close();
    }
  },
);
