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
  const updateSource = await readFile(
    resolve(compiledTestDir, "../../src/upgrade/desktop-update.ts"),
    "utf8",
  );
  const updateStage = updateSource.indexOf("await controller.checkAndStage()");

  assert.match(source, /async function boot\(mode: BootMode\): Promise<void>/u);
  assert.ok(runtimeConstruction >= 0);
  assert.ok(leaseBlock > runtimeConstruction);
  assert.ok(serviceConstruction > leaseBlock);
  assert.match(source, /\{ recoveryReadOnly: mode === "recovery" \}/u);
  assert.match(source, /await boot\(updates\.mode\)/u);
  assert.match(source, /if \(updates\.mode === "normal"\) updates\.confirm\(\)/u);
  assert.match(
    updateSource,
    /const mode = startup\.action === "recovery" \? \("recovery" as const\)/u,
  );
  assert.match(
    updateSource,
    /if \(startup\.action === "continue" && startup\.pendingConfirmation\)/u,
  );
  const updateGuard = updateSource.indexOf(
    'if (!config.enabled || mode !== "normal" || !publicKey) return;',
  );
  assert.ok(updateGuard > 0);
  assert.ok(updateStage > updateGuard);
});
