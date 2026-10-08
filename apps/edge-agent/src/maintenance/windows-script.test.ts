import assert from "node:assert/strict";
import test from "node:test";

import { MAINTENANCE_BOOTSTRAP, maintenanceCommand } from "./windows-script.js";

test("progress is off before the trust script's first command runs", () => {
  const trust = "Add-Type -TypeDefinition 'public static class TrustFixture {}'";
  const command = maintenanceCommand(trust);
  const progress = command.indexOf("$ProgressPreference = 'SilentlyContinue'");
  assert.ok(progress >= 0 && progress < command.indexOf(trust));
  assert.ok(command.endsWith(MAINTENANCE_BOOTSTRAP));
});

test("the Runtime is looked up under LOCALAPPDATA, where its installer puts it", () => {
  // The known-folder API ignores a redirected LOCALAPPDATA, so the counter missed the Runtime.
  assert.doesNotMatch(MAINTENANCE_BOOTSTRAP, /GetFolderPath/u);
  assert.ok(MAINTENANCE_BOOTSTRAP.includes("$local = $env:LOCALAPPDATA\n"));
  assert.ok(MAINTENANCE_BOOTSTRAP.includes("$local -cnotmatch '^[A-Za-z]:\\\\'"));
  assert.ok(
    MAINTENANCE_BOOTSTRAP.includes(
      "[IO.Path]::Combine($local,'Programs','Laundry Desk Runtime V2',$q.manifest_sha256)",
    ),
  );
});
