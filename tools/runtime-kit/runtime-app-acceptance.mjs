import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const kitRoot = dirname(fileURLToPath(import.meta.url));
const testApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
const signingKey = join(kitRoot, "dist/test-signing-private.pem");
const runNode = (arguments_) =>
  execute(process.execPath, arguments_, { maxBuffer: 2 * 1024 * 1024 });

try {
  if (process.argv.length !== 2) throw new Error("RUNTIME_ACCEPTANCE_ARGS_INVALID");
  await runNode([join(kitRoot, "build-app.mjs"), "--testing"]);
  await runNode([join(kitRoot, "inspect-app.mjs"), testApp]);
  for (const script of ["no-repo-acceptance.mjs", "no-repo-lan-acceptance.mjs"]) {
    const result = await runNode([join(kitRoot, script), "--orchestrated"]);
    process.stdout.write(result.stdout);
  }
  process.stdout.write("RUNTIME_NATIVE_APP_ACCEPTANCE_OK suites=2\n");
} finally {
  await rm(signingKey, { force: true });
}
