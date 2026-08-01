import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const kitRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const appRoot = resolve(process.argv[2] ?? join(kitRoot, "dist/Laundry Desk Runtime.app"));
const executable = join(appRoot, "Contents/MacOS/Laundry Desk Runtime");
const resources = join(appRoot, "Contents/Resources");

assert.equal((await stat(executable)).isFile(), true);
const { stdout: architectures } = await execute("/usr/bin/lipo", ["-archs", executable]);
assert.equal(architectures.trim(), "arm64");
await execute("/usr/bin/codesign", ["--verify", "--strict", appRoot]);
assert.deepEqual((await readdir(resources)).sort(), [
  "docker-compose.runtime.yml",
  "trusted-manifest-public-key.txt",
]);
const compose = await readFile(join(resources, "docker-compose.runtime.yml"), "utf8");
assert.doesNotMatch(compose, /^\s*(?:build|context):/mu);
assert.doesNotMatch(compose, /\.\.\/|packages\/|apps\/|tools\//u);
const bundleFiles = await readdir(join(appRoot, "Contents/MacOS"));
assert.deepEqual(bundleFiles, ["Laundry Desk Runtime"]);
process.stdout.write(`RUNTIME_APP_INSPECT_OK ${appRoot}\n`);
