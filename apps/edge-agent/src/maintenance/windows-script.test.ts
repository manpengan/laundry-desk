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
  assert.doesNotMatch(gui, /& \$entry -Action gui/u);
  // Start-Process (ShellExecute) inherits no handles, so the window cannot hold the Counter's pipes open.
  assert.match(
    gui,
    /\$p=Start-Process \(\$PSHOME\+'\\powershell\.exe'\) .* -WindowStyle Hidden -PassThru\n/u,
  );
  assert.doesNotMatch(gui, /ProcessStartInfo|Redirect/u);
  // The handoff can carry an approval request id: it is set in the environment only around the start,
  // and the window's command line holds only fixed code.
  const launcher = /GetBytes\('(.*)'\)\)\) -WindowStyle/u.exec(gui)?.[1] ?? "";
  assert.ok(launcher.includes("[Convert]::FromBase64String($env:LAUNDRY_HANDOFF)"));
  assert.ok(launcher.includes("$env:LAUNDRY_HANDOFF=$null"));
  assert.doesNotMatch(launcher, /request_id|\$q\b|\$entry/u);
  assert.ok(gui.indexOf("$env:LAUNDRY_HANDOFF=$null\n") > gui.indexOf("Start-Process"));
  // The verified entry stays held until the window is shown.
  assert.ok(gui.indexOf("MainWindowHandle -eq 0){throw") < gui.indexOf("maintenance_opened"));
  assert.ok(
    MAINTENANCE_BOOTSTRAP.indexOf("maintenance_opened") <
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
