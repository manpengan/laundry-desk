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
