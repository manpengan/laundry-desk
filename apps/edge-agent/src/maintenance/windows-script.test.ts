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

test("the maintenance window runs in its own process so quitting the Counter leaves it open", () => {
  // Node's kill-on-close job ends the Counter's children when it quits; grandchildren leave that job.
  const gui = MAINTENANCE_BOOTSTRAP.slice(MAINTENANCE_BOOTSTRAP.indexOf("  else {"));
  assert.ok(gui.includes("[Diagnostics.Process]::Start($psi)"));
  assert.doesNotMatch(gui, /& \$entry -Action gui/u);
  // The handoff, which can carry an approval request id, goes over stdin and never onto a command line.
  assert.ok(
    gui.includes(
      "-EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))",
    ),
  );
  assert.ok(gui.includes("$window.StandardInput.WriteLine("));
  assert.doesNotMatch(
    MAINTENANCE_BOOTSTRAP.match(/\$launcher = '.*'\n/u)?.[0] ?? "",
    /request_id|\$q\b/u,
  );
  // The verified entry stays held until the window confirms it opened.
  assert.ok(
    MAINTENANCE_BOOTSTRAP.indexOf("[Console]::Out.WriteLine($opened.Result)") <
      MAINTENANCE_BOOTSTRAP.indexOf("finally {"),
  );
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
