import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import test, { after, before } from "node:test";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const signingKey = join("tools", "runtime-kit", "dist", "test-signing-private.pem");

before(
  async () => {
    if (process.platform !== "darwin") return;
    await execute(process.execPath, ["tools/runtime-kit/build-app.mjs", "--testing"], {
      maxBuffer: 2 * 1024 * 1024,
    });
  },
  { timeout: 120_000 },
);

after(async () => rm(signingKey, { force: true }));

test(
  "native Runtime.app installs, restarts, diagnoses, and recovers without repo or host Node",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async () => {
    const { stdout } = await execute(
      process.execPath,
      ["tools/runtime-kit/no-repo-acceptance.mjs", "--orchestrated"],
      {
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.match(stdout, /RUNTIME_NATIVE_NO_REPO_ACCEPTANCE_OK scenarios=73 manifest_negatives=8/u);
  },
);

test(
  "native Runtime.app manages LAN and bounded support evidence without repo or host Node",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async () => {
    const { stdout } = await execute(
      process.execPath,
      ["tools/runtime-kit/no-repo-lan-acceptance.mjs", "--orchestrated"],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    assert.match(stdout, /RUNTIME_NATIVE_NO_REPO_LAN_MAINTENANCE_ACCEPTANCE_OK scenarios=16/u);
    assert.match(stdout, /RUNTIME_NATIVE_NO_REPO_LAN_ACCEPTANCE_OK scenarios=34/u);
  },
);
