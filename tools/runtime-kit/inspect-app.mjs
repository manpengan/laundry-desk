import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { RUNTIME_ARCHITECTURES } from "./build-app.mjs";

const execute = promisify(execFile);
const kitRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));

export function parseRuntimeArchitectures(output) {
  const architectures = output.trim().split(/\s+/u).filter(Boolean).sort();
  assert.deepEqual(architectures, [...RUNTIME_ARCHITECTURES].sort());
  return Object.freeze(architectures);
}

async function listRegularBundleFiles(root) {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) throw new Error(`RUNTIME_APP_SYMLINK_FORBIDDEN ${root}`);
  if (metadata.isFile()) return [root];
  if (!metadata.isDirectory()) throw new Error(`RUNTIME_APP_SPECIAL_FILE_FORBIDDEN ${root}`);
  const children = await readdir(root);
  const nested = await Promise.all(
    children.sort().map((child) => listRegularBundleFiles(join(root, child))),
  );
  return nested.flat();
}

async function inspectMachOBinaries(appRoot, executable, run) {
  const binaries = [];
  for (const path of await listRegularBundleFiles(appRoot)) {
    const { stdout: description } = await run("/usr/bin/file", ["-b", path], {
      encoding: "utf8",
      maxBuffer: 512 * 1024,
    });
    if (!/^Mach-O\b/u.test(description.trim())) continue;
    const { stdout: architectures } = await run("/usr/bin/lipo", ["-archs", path], {
      encoding: "utf8",
      maxBuffer: 512 * 1024,
    });
    parseRuntimeArchitectures(architectures);
    binaries.push(path);
  }
  assert.equal(binaries.includes(executable), true, "Runtime executable is not Mach-O");
  return Object.freeze(binaries.map((path) => relative(appRoot, path)));
}

export async function inspectRuntimeApp(appRoot, dependencies = {}) {
  const run = dependencies.execute ?? execute;
  const executable = join(appRoot, "Contents/MacOS/Laundry Desk Runtime");
  const resources = join(appRoot, "Contents/Resources");

  assert.equal((await lstat(executable)).isFile(), true);
  const machOBinaries = await inspectMachOBinaries(appRoot, executable, run);
  await run("/usr/bin/codesign", ["--verify", "--strict", appRoot]);
  assert.deepEqual((await readdir(resources)).sort(), [
    "docker-compose.runtime.yml",
    "trusted-manifest-public-key.txt",
  ]);
  const compose = await readFile(join(resources, "docker-compose.runtime.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s*(?:build|context):/mu);
  assert.doesNotMatch(compose, /\.\.\/|packages\/|apps\/|tools\//u);
  const trustedKey = await readFile(join(resources, "trusted-manifest-public-key.txt"), "utf8");
  assert.match(trustedKey, /^[A-Za-z0-9_-]{43}\n$/u);
  const bundleFiles = await readdir(join(appRoot, "Contents/MacOS"));
  assert.deepEqual(bundleFiles, ["Laundry Desk Runtime"]);
  return Object.freeze({
    appRoot,
    architectures: [...RUNTIME_ARCHITECTURES].sort(),
    machOBinaries,
  });
}

async function main() {
  if (process.argv.length > 3) throw new Error("RUNTIME_INSPECT_ARGS_INVALID");
  const appRoot = resolve(process.argv[2] ?? join(kitRoot, "dist/Laundry Desk Runtime.app"));
  await inspectRuntimeApp(appRoot);
  process.stdout.write(`RUNTIME_APP_INSPECT_OK ${appRoot}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  await main();
}
