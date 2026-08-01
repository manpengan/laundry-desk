import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test(
  "native Runtime.app installs, restarts, diagnoses, and recovers without repo or host Node",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  async () => {
    await execute(process.execPath, ["tools/runtime-kit/build-app.mjs", "--testing"], {
      maxBuffer: 2 * 1024 * 1024,
    });
    const { stdout } = await execute(
      process.execPath,
      ["tools/runtime-kit/no-repo-acceptance.mjs"],
      {
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.match(stdout, /RUNTIME_NATIVE_NO_REPO_ACCEPTANCE_OK scenarios=14/u);
  },
);
