import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";

import { PrinterConfigStore } from "./printer-config.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laundry-printer-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = join(root, "printing");
  const store = await PrinterConfigStore.open(configRoot, {
    randomStagingId: () => "0123456789abcdef01234567",
  });
  return Object.freeze({ root, configRoot, store });
}

test("PrinterConfigStore writes and reads exact private v1 queue state", async (t) => {
  const { configRoot, store } = await fixture(t);
  await store.write(Object.freeze({ version: 1, queue: "XP58_USB" }));

  assert.deepEqual(await store.read(), { version: 1, queue: "XP58_USB" });
  if (process.platform === "win32") {
    assert.equal((await inspectPrivateDirectory(configRoot)).scheme, "windows-dacl-v1");
    assert.equal(
      (await inspectPrivateFile(join(configRoot, "printer-config.json"))).scheme,
      "windows-dacl-v1",
    );
  } else {
    assert.equal((await stat(configRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(configRoot, "printer-config.json"))).mode & 0o777, 0o600);
  }

  await store.write(Object.freeze({ version: 1, queue: null }));
  assert.deepEqual(await store.read(), { version: 1, queue: null });
});

test("PrinterConfigStore rejects unknown fields and unsafe queue names", async (t) => {
  const { configRoot, store } = await fixture(t);
  const path = join(configRoot, "printer-config.json");
  await writeFile(path, '{"version":1,"queue":"XP58","path":"/tmp/raw"}\n', { mode: 0o600 });
  await chmod(path, 0o600);
  await assert.rejects(() => store.read());

  await writeFile(path, '{"version":1,"queue":"../XP58"}\n', { mode: 0o600 });
  await assert.rejects(() => store.read());
});
