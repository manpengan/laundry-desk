import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { buildPreloadBundle } from "./build-preload.mjs";

const COMPILED_PRELOAD = `import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./lib/security-prefs.js";
const EMPTY_DESKTOP_INPUT = Object.freeze({});
const laundryDesktop = Object.freeze({
  auth: Object.freeze({
    login: (input) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.auth.login, input),
  }),
});
contextBridge.exposeInMainWorld("laundryDesktop", laundryDesktop);
`;

const COMPILED_SECURITY_PREFS = `export const DESKTOP_IPC_CHANNELS = Object.freeze({
  auth: Object.freeze({ login: "desktop:auth:login" }),
});
`;

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-preload-bundle-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true }));
  });
  const compiledPreloadPath = join(root, "preload.js");
  const compiledSecurityPrefsPath = join(root, "security-prefs.mjs");
  const outputPath = join(root, "preload.cjs");
  await writeFile(compiledPreloadPath, COMPILED_PRELOAD);
  await writeFile(compiledSecurityPrefsPath, COMPILED_SECURITY_PREFS);
  return { compiledPreloadPath, compiledSecurityPrefsPath, outputPath };
}

test("buildPreloadBundle emits one executable CommonJS preload with channels inlined", async (t) => {
  const paths = await createFixture(t);
  await buildPreloadBundle(paths);
  const bundle = await readFile(paths.outputPath, "utf8");

  assert.match(bundle, /^"use strict";/u);
  assert.match(bundle, /require\("electron"\)/u);
  assert.doesNotMatch(bundle, /^\s*(?:import|export)\s/mu);
  assert.doesNotMatch(bundle, /security-prefs/u);
  assert.doesNotMatch(bundle, /sourceMappingURL/u);

  const exposed = [];
  const invocations = [];
  vm.runInNewContext(bundle, {
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            exposed.push({ name, value });
          },
        },
        ipcRenderer: {
          invoke(channel, input) {
            invocations.push({ channel, input });
            return Promise.resolve({ ok: true });
          },
        },
      };
    },
  });

  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, "laundryDesktop");
  await exposed[0].value.auth.login({ username: "admin" });
  assert.deepEqual(invocations, [{ channel: "desktop:auth:login", input: { username: "admin" } }]);
});

test("buildPreloadBundle fails closed without replacing an existing bundle", async (t) => {
  const paths = await createFixture(t);
  await writeFile(paths.compiledPreloadPath, "console.log('unexpected source shape');\n");
  await writeFile(paths.outputPath, "known-good\n");

  await assert.rejects(() => buildPreloadBundle(paths), /compiled preload imports/u);
  assert.equal(await readFile(paths.outputPath, "utf8"), "known-good\n");
});

test("buildPreloadBundle rejects executable channel initializers without replacing output", async (t) => {
  const paths = await createFixture(t);
  await writeFile(
    paths.compiledSecurityPrefsPath,
    `export const DESKTOP_IPC_CHANNELS = (() => ({
  auth: { login: "desktop:auth:login" },
}))();
`,
  );
  await writeFile(paths.outputPath, "known-good\n");

  await assert.rejects(() => buildPreloadBundle(paths), /must use Object\.freeze/u);
  assert.equal(await readFile(paths.outputPath, "utf8"), "known-good\n");
});
