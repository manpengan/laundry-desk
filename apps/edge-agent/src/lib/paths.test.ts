import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preloadPathFromDistDir, spaRootForRuntime } from "./paths.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("spaRootForRuntime uses the package resource in development", () => {
  assert.equal(
    spaRootForRuntime({
      isPackaged: false,
      packageRoot: "/workspace/apps/edge-agent",
      resourcesPath: "/runtime/resources",
    }),
    join("/workspace/apps/edge-agent", "resources", "spa"),
  );
});

test("spaRootForRuntime uses the extraResources root when packaged", () => {
  assert.equal(
    spaRootForRuntime({
      isPackaged: true,
      packageRoot: "/app/laundry-desk-v2.asar",
      resourcesPath: "/Applications/laundry-desk V2.app/Contents/Resources",
    }),
    join("/Applications/laundry-desk V2.app/Contents/Resources", "spa"),
  );
});

test("preloadPathFromDistDir selects the sandbox-compatible CJS bundle", () => {
  assert.equal(
    preloadPathFromDistDir("/workspace/apps/edge-agent/dist"),
    join("/workspace/apps/edge-agent/dist", "preload.cjs"),
  );
});

test("main wires app packaging state and process.resourcesPath into SPA resolution", () => {
  const mainSource = readFileSync(join(packageRoot, "src", "main.ts"), "utf8");

  assert.match(mainSource, /spaRootForRuntime\(\{/u);
  assert.match(mainSource, /isPackaged:\s*app\.isPackaged/u);
  assert.match(mainSource, /resourcesPath:\s*process\.resourcesPath/u);
});
