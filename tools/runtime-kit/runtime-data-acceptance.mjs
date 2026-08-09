import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const kitRoot = dirname(fileURLToPath(import.meta.url));
const testApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
const signingKey = join(kitRoot, "dist/test-signing-private.pem");
const runNode = async (arguments_, timeout, failureCode) => {
  try {
    return await execute(process.execPath, arguments_, {
      maxBuffer: 2 * 1024 * 1024,
      timeout,
      killSignal: "SIGKILL",
    });
  } catch {
    throw new Error(failureCode);
  }
};

try {
  if (process.argv.length !== 2) throw new Error("RUNTIME_ACCEPTANCE_ARGS_INVALID");
  await runNode(
    [join(kitRoot, "build-app.mjs"), "--testing"],
    15 * 60_000,
    "RUNTIME_DATA_BUILD_ACCEPTANCE_FAILED",
  );
  await runNode(
    [join(kitRoot, "inspect-app.mjs"), testApp],
    2 * 60_000,
    "RUNTIME_DATA_INSPECT_ACCEPTANCE_FAILED",
  );
  for (const [script, failureCode] of [
    ["no-repo-maintenance-acceptance.mjs", "RUNTIME_DATA_MAINTENANCE_ACCEPTANCE_FAILED"],
    ["no-repo-transfer-acceptance.mjs", "RUNTIME_DATA_TRANSFER_ACCEPTANCE_FAILED"],
  ]) {
    const result = await runNode(
      [join(kitRoot, script), "--orchestrated"],
      5 * 60_000,
      failureCode,
    );
    process.stdout.write(result.stdout);
  }
  process.stdout.write("RUNTIME_DATA_NO_REPO_ACCEPTANCE_OK suites=2\n");
} finally {
  await rm(signingKey, { force: true });
}
