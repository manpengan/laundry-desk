import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the Electron entrypoint boots recovery without confirmation or update staging", async () => {
  const compiledTestDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(compiledTestDir, "../../src/main.ts"), "utf8");
  const runtimeConstruction = source.indexOf("offlineRuntime = new OfflineCommandRuntime");
  const leaseBlock = source.indexOf(
    'if (mode === "recovery") offlineRuntime.setLeaseIssuanceBlocked',
  );
  const serviceConstruction = source.indexOf("const desktopService = createOfflineDesktopService");
  const updateStage = source.indexOf("void controller.checkAndStage()");

  assert.match(source, /async function boot\(mode: BootMode\): Promise<void>/u);
  assert.ok(runtimeConstruction >= 0);
  assert.ok(leaseBlock > runtimeConstruction);
  assert.ok(serviceConstruction > leaseBlock);
  assert.match(source, /\{ recoveryReadOnly: mode === "recovery" \}/u);
  assert.match(source, /if \(startup\.action === "recovery"\) \{\s*bootMode = "recovery";/u);
  assert.match(
    source,
    /if \(bootMode === "normal" && updateState !== null && pendingConfirmation !== null\)/u,
  );
  assert.ok(updateStage > 0);
  assert.ok(
    source.lastIndexOf('bootMode === "normal"', updateStage) > source.indexOf("await boot"),
  );
});
