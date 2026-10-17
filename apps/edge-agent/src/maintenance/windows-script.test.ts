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
  assert.ok(gui.includes("$p=[Diagnostics.Process]::Start($w)"));
  assert.doesNotMatch(gui, /& \$entry -Action gui/u);
  // The handoff can carry an approval request id: it goes over stdin, and the window's command line
  // holds only fixed code.
  const launcher = /GetBytes\('(.*)'\)\)\n/u.exec(gui)?.[1] ?? "";
  assert.ok(
    launcher.startsWith(
      "$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
    ),
  );
  assert.doesNotMatch(launcher, /request_id|\$q\b|\$entry/u);
  assert.ok(gui.includes("$p.StandardInput.WriteLine("));
  // The verified entry stays held until the window confirms it opened.
  assert.ok(
    MAINTENANCE_BOOTSTRAP.indexOf("[Console]::Out.WriteLine($o.Result)") <
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
