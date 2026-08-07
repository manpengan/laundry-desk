import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kitRoot = join(repositoryRoot, "tools/runtime-kit");

const sourceAllowlist = Object.freeze([
  ".gitignore",
  "README.md",
  "Resources/trusted-manifest-public-key.txt",
  "Sources/FakeRuntimeRunner.swift",
  "Sources/FakeStreamingRunner.swift",
  "Sources/LaunchAgent.swift",
  "Sources/ManifestVerifier.swift",
  "Sources/ProcessRunner.swift",
  "Sources/RuntimeBackupCodec.swift",
  "Sources/RuntimeBackupCommands.swift",
  "Sources/RuntimeBackupController.swift",
  "Sources/RuntimeBackupModels.swift",
  "Sources/RuntimeCLI.swift",
  "Sources/RuntimeController.swift",
  "Sources/RuntimeGUI.swift",
  "Sources/RuntimeModels.swift",
  "Sources/RuntimeStorage.swift",
  "Sources/StreamingRunner.swift",
  "Sources/main.swift",
  "build-app.mjs",
  "inspect-app.mjs",
  "no-repo-acceptance.mjs",
  "real-container-acceptance.mjs",
]);

const sourceFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "build" || entry.name === "dist") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)));
    else files.push(relative(kitRoot, absolute));
  }
  return files;
};

test("runtime kit source allowlist excludes generated apps, binaries, and private keys", async () => {
  assert.equal(await readFile(join(kitRoot, ".gitignore"), "utf8"), "/build/\n/dist/\n");
  assert.deepEqual((await sourceFiles(kitRoot)).sort(), [...sourceAllowlist].sort());

  const ignored = await execute(
    "/usr/bin/git",
    ["check-ignore", "tools/runtime-kit/build/private.pem", "tools/runtime-kit/dist/runtime.app"],
    { cwd: repositoryRoot },
  );
  assert.deepEqual(ignored.stdout.trim().split("\n"), [
    "tools/runtime-kit/build/private.pem",
    "tools/runtime-kit/dist/runtime.app",
  ]);

  const tracked = await execute("/usr/bin/git", ["ls-files", "tools/runtime-kit"], {
    cwd: repositoryRoot,
  });
  assert.doesNotMatch(
    tracked.stdout,
    /(?:^|\/)(?:build|dist)\/|\.(?:app|dylib|pem|p12|key)(?:\n|$)/u,
  );
});
